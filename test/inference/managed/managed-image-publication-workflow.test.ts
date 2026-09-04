// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  publicationAgents,
  publicationPlatforms,
  reuseOpenclawAmd64FromAttemptOne,
  runManagedImageBaseRestore,
  runManagedImagePromotion,
  runPublicationBarrier,
} from "../../helpers/managed-image-publication-barrier";
import {
  baseImagePlatformCallers,
  baseImagePublishers,
  managedPromoter,
  managedPublisher,
  readAction,
  readWorkflow,
  repoRoot,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";
import type {
  Job,
  MatrixEntry,
  Workflow,
} from "../../helpers/managed-image-publication-workflow-types";

const fullShaAction = /^[^@]+@[0-9a-f]{40}$/iu;

function needsOutput(job: string, output: string): string {
  return `\${{ needs.${job}.outputs.${output} }}`;
}

function inlineNodeStdinValidator(source: string): string {
  return required(
    source.match(/if ! node -e '([\s\S]+?)' <<< "\$actual_discovery_contract"/u)?.[1],
    "managed-image workflow is missing or has an incomplete inline Node validator",
  ).trim();
}

function isStrictChildPath(root: string, candidate: string): boolean {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

const managedBuilder = managedPublisher;

function managedPrBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-build-and-entrypoint"],
    "managed-image workflow is missing its all-agent PR build and runtime gate",
  );
}

function managedPrReviewedAudit(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-reviewed-npm-audit"],
    "managed-image workflow is missing its exact PR reviewed npm audit",
  );
}

function managedPrActivation(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-managed-activation"],
    "managed-image workflow is missing its exact all-agent PR activation gate",
  );
}

function managedPrOpenClawMcpDiscovery(workflow: Workflow): Job {
  return required(workflow.jobs?.["pr-openclaw-mcp-discovery"], "missing exact PR MCP gate");
}

describe("complete managed-image publication workflow", () => {
  it("supplies Pi's managed route placeholder to both Fabric doctor checks", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const candidate = required(
      workflow.jobs?.["pi-candidate"],
      "managed-image workflow is missing the Pi candidate lane",
    );
    const doctorCommand =
      "PI_FABRIC_API_KEY=nemoclaw-managed-inference nemoclaw-fabric doctor";

    expect(step(candidate, "Validate the Pi candidate runtime contract").run).toContain(
      doctorCommand,
    );
    expect(step(candidate, "Validate the published Pi candidate digest").run).toContain(
      doctorCommand,
    );
  });

  it("restricts reviewed npm audit cache publication to trusted callers (#11028)", () => {
    const action = readAction("ci-reviewed-npm-audit") as ReturnType<typeof readAction> & {
      inputs: Record<string, { default?: string; required?: boolean }>;
    };
    const actionSteps = action.runs?.steps ?? [];
    const restores = actionSteps.filter((candidate) =>
      candidate.uses?.startsWith("actions/cache/restore@"),
    );
    expect(action.inputs).toMatchObject({
      "cache-directory": { required: true },
      "trusted-cache-write": { default: "false", required: false },
    });
    expect(restores).toHaveLength(2);
    expect(restores.map(({ uses }) => uses)).toEqual([
      "actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809",
      "actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809",
    ]);
    expect(restores.map(({ with: inputs }) => inputs)).toEqual([
      {
        key: "reviewed-npm-audit-v1-${{ runner.os }}-${{ steps.cache-buckets.outputs.input-digest }}-${{ steps.cache-buckets.outputs.current }}",
        path: "${{ inputs.cache-directory }}",
      },
      {
        key: "reviewed-npm-audit-v1-${{ runner.os }}-${{ steps.cache-buckets.outputs.input-digest }}-${{ steps.cache-buckets.outputs.previous }}",
        path: "${{ inputs.cache-directory }}",
      },
    ]);
    const save = step(
      { steps: actionSteps },
      "Save current reviewed npm audit cache bucket",
      "reviewed npm audit action",
    );
    expect(save).toMatchObject({
      if: "inputs.trusted-cache-write == 'true' && steps.cache-current.outputs.cache-hit != 'true'",
      uses: "actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809",
      with: restores[0]?.with,
    });
    expect(
      step(
        { steps: actionSteps },
        "Materialize and audit reviewed npm graphs",
        "reviewed npm audit action",
      ).env,
    ).toMatchObject({
      NEMOCLAW_REVIEWED_NPM_AUDIT_CACHE_DIR: "${{ inputs.cache-directory }}",
      NPM_CONFIG_USERCONFIG: "/dev/null",
    });

    const prAudit = step(
      required(readWorkflow("pr.yaml").jobs?.["reviewed-npm-audit"], "missing PR audit"),
      "Audit reviewed production npm graphs",
    );
    const mainAudit = step(
      required(readWorkflow("main.yaml").jobs?.["reviewed-npm-audit"], "missing main audit"),
      "Audit reviewed production npm graphs",
    );
    const managedAudit = step(
      managedPrReviewedAudit(readWorkflow("managed-images.yaml")),
      "Audit exact PR production npm graphs",
    );
    expect(prAudit.with?.["cache-directory"]).toBe("${{ runner.temp }}/reviewed-npm-audit-cache");
    expect(managedAudit.with?.["cache-directory"]).toBe("${{ runner.temp }}/reviewed-npm-audit-cache");
    expect(prAudit.with?.["trusted-cache-write"]).toBeUndefined();
    expect(managedAudit.with?.["trusted-cache-write"]).toBeUndefined();
    expect(mainAudit.with).toMatchObject({
      "cache-directory": "${{ runner.temp }}/reviewed-npm-audit-cache",
      "trusted-cache-write": "true",
    });
  });
  it("rejects managed package paths redirected outside node_modules", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-plugin-"));
    try {
      const nodeModulesRoot = path.join(fixtureRoot, "project", "node_modules");
      const outsideScope = path.join(fixtureRoot, "outside-scope");
      const installedPackageRoot = path.join(nodeModulesRoot, "direct-package");
      const escapedPackageRoot = path.join(nodeModulesRoot, "@scope", "plugin");
      fs.mkdirSync(installedPackageRoot, { recursive: true });
      fs.mkdirSync(path.join(outsideScope, "plugin"), { recursive: true });
      fs.symlinkSync(outsideScope, path.join(nodeModulesRoot, "@scope"));
      expect(isStrictChildPath(nodeModulesRoot, installedPackageRoot)).toBe(true);
      expect(isStrictChildPath(nodeModulesRoot, escapedPackageRoot)).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("starts managed publication after exact base contracts without canceling release tags (#7744)", () => {
    const baseWorkflow = readWorkflow("base-image.yaml");
    const managedWorkflow = readWorkflow("managed-images.yaml");
    const publisher = required(
      baseWorkflow.jobs?.["publish-managed-images"],
      "base-image workflow is missing the managed-image publisher",
    );
    expect(JSON.stringify(managedWorkflow)).not.toContain("config.plugins?.installs?.[id]");
    const validationRun =
      step(managedPublisher(managedWorkflow), "Validate exact managed image before promotion")
        .run ?? "";
    expect(validationRun).not.toContain('path.join(projectsRoot, entry.name, "package.json")');
    const channelGuardEnd = validationRun.indexOf("managed OpenClaw channel");
    const channelGuardStart = validationRun.lastIndexOf("for (const id of [", channelGuardEnd);
    expect(channelGuardStart).toBeGreaterThan(-1);
    expect(validationRun.slice(channelGuardStart, channelGuardEnd)).toContain('"googlechat",');
    expect(publisher).toMatchObject({
      needs: [
        "build-and-push-hermes",
        "build-and-push-dcode",
        "build-and-push-openclaw",
        "reviewed-npm-audit",
      ],
      permissions: {
        contents: "read",
        packages: "write",
      },
      uses: "./.github/workflows/managed-images.yaml",
    });
    expect(publisher.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(publisher.if).toContain("github.ref == 'refs/heads/main'");
    expect(publisher.if).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(publisher.with).toMatchObject({
      "dcode-base-contract-base64": needsOutput("build-and-push-dcode", "contract-base64"),
      "hermes-base-contract-base64": needsOutput("build-and-push-hermes", "contract-base64"),
      "openclaw-base-contract-base64": needsOutput("build-and-push-openclaw", "contract-base64"),
    });
    const reviewedAudit = required(
      baseWorkflow.jobs?.["reviewed-npm-audit"],
      "base-image workflow is missing the reviewed npm audit",
    );
    expect(reviewedAudit).toMatchObject({
      if: "github.repository == 'NVIDIA/NemoClaw'",
      permissions: { contents: "read" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 25,
    });
    expect(step(reviewedAudit, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(reviewedAudit, "Audit reviewed production npm graphs")).toMatchObject({
      uses: "./.github/actions/ci-reviewed-npm-audit",
      with: {
        "cache-directory": "${{ runner.temp }}/reviewed-npm-audit-cache",
        "report-dir": "artifacts/reviewed-npm-audit",
        "target-root": "${{ github.workspace }}",
        "trusted-cache-write": "${{ github.repository == 'NVIDIA/NemoClaw' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}",
      },
    });
  });

  it.each(baseImagePublishers)(
    "binds the $agent manifest to reusable architecture callers (#9529)",
    (expectedPublisher) => {
      const baseWorkflow = readWorkflow("base-image.yaml");
      const publisher = required(
        baseWorkflow.jobs?.[expectedPublisher.job],
        `base-image workflow is missing ${expectedPublisher.agent} manifest publisher`,
      );
      expect(publisher.needs).toEqual([
        expectedPublisher.amd64Job,
        expectedPublisher.arm64Job,
        "reviewed-npm-audit",
      ]);
      expect(
        step(publisher, "Publish validated multi-platform manifest", "base-image workflow"),
      ).toMatchObject({
        uses: "./.github/actions/publish-base-image-manifest",
        with: {
          agent: expectedPublisher.agent,
          "amd64-digest": needsOutput(expectedPublisher.amd64Job, "digest"),
          "arm64-digest": needsOutput(expectedPublisher.arm64Job, "digest"),
          "display-name": expectedPublisher.displayName,
          image: expectedPublisher.image,
          registry: "${{ env.REGISTRY }}",
          "registry-password": "${{ secrets.GITHUB_TOKEN }}",
          "registry-username": "${{ github.actor }}",
        },
      });
      expect(publisher.outputs?.["contract-base64"]).toBe(
        "${{ steps.publish.outputs.contract-base64 }}",
      );
      expect(step(publisher, "Checkout", "base-image workflow").with).toMatchObject({
        "persist-credentials": false,
      });
    },
  );

  it.each(baseImagePlatformCallers)(
    "calls one reusable builder for $agent $arch while retaining its digest output (#9529)",
    (expectedCaller) => {
      const caller = required(
        readWorkflow("base-image.yaml").jobs?.[expectedCaller.job],
        `base-image workflow is missing ${expectedCaller.agent} ${expectedCaller.arch}`,
      );
      expect(caller).toMatchObject({
        if: "github.repository == 'NVIDIA/NemoClaw'",
        needs: ["reviewed-npm-audit"],
        permissions: { contents: "read", packages: "write" },
        secrets: { registry_password: "${{ secrets.GITHUB_TOKEN }}" },
        uses: "./.github/workflows/base-image-platform.yaml",
        with: {
          agent: expectedCaller.agent,
          arch: expectedCaller.arch,
          dockerfile: expectedCaller.dockerfile,
          image: expectedCaller.image,
          platform: expectedCaller.platform,
          runner: expectedCaller.runner,
        },
      });
      expect(caller.strategy).toBeUndefined();
      expect(caller.steps).toBeUndefined();
      expect(caller["runs-on"]).toBeUndefined();
      expect(caller.with?.["openclaw-version"]).toBe(expectedCaller.openclawVersion);
    },
  );

  it("defines the platform build in one reusable workflow (#9529)", () => {
    const workflow = readWorkflow("base-image-platform.yaml");
    const call = required(workflow.on?.workflow_call, "platform workflow is not reusable");
    const builder = required(workflow.jobs?.build, "platform workflow is missing its builder");
    expect(Object.keys(call.inputs ?? {}).sort()).toEqual([
      "agent",
      "arch",
      "dockerfile",
      "image",
      "openclaw-version",
      "platform",
      "runner",
    ]);
    expect(call.outputs?.digest?.value).toBe("${{ jobs.build.outputs.digest }}");
    expect(call.secrets?.registry_password?.required).toBe(true);
    expect(builder).toMatchObject({
      permissions: { contents: "read", packages: "write" },
      "runs-on": "${{ inputs.runner }}",
      "timeout-minutes": 60,
    });
    expect(builder.outputs?.digest).toContain("steps.platform.outputs");
    expect(step(builder, "Checkout", "base-image platform workflow").with).toMatchObject({
      "persist-credentials": false,
    });
    expect(
      step(builder, "Build and publish platform digest", "base-image platform workflow"),
    ).toMatchObject({
      id: "platform",
      uses: "./.github/actions/build-base-image-platform",
      with: {
        agent: "${{ inputs.agent }}",
        arch: "${{ inputs.arch }}",
        dockerfile: "${{ inputs.dockerfile }}",
        image: "${{ inputs.image }}",
        "openclaw-version": "${{ inputs.openclaw-version }}",
        platform: "${{ inputs.platform }}",
        registry: "ghcr.io",
        "registry-password": "${{ secrets.registry_password }}",
        "registry-username": "${{ github.actor }}",
      },
    });
  });
  it("exports one architecture-specific digest from every native platform action (#9529)", () => {
    const action = readAction("build-base-image-platform");
    expect(action.outputs).toMatchObject({
      digest: { value: "${{ steps.build.outputs.digest }}" },
      "amd64-digest": { value: "${{ steps.job-output.outputs.amd64_digest }}" },
      "arm64-digest": { value: "${{ steps.job-output.outputs.arm64_digest }}" },
    });
    expect(action.outputs?.["amd64-digest"]?.value).not.toBe(
      action.outputs?.["arm64-digest"]?.value,
    );
    const exportDigest = step(
      { steps: action.runs?.steps },
      "Export platform digest",
      "build-base-image-platform action",
    );
    expect(exportDigest.run).toContain('printf \'%s_digest=%s\\n\' "$ARCH" "$DIGEST"');
  });

  it("publishes native base images without GitHub API metadata", () => {
    const action = readAction("build-base-image-platform");
    const platformBuild = step(
      { steps: action.runs?.steps },
      "Build and push platform digest",
      "build-base-image-platform action",
    );
    expect(platformBuild.with?.labels).toBe(
      "org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}\n" +
        "org.opencontainers.image.revision=${{ github.sha }}\n",
    );
    expect(JSON.stringify(action)).not.toContain('"metadata-tags"');
    expect(
      action.runs?.steps?.some((candidate) => candidate.uses?.includes("metadata-action")),
    ).toBe(false);

    const manifestAction = readAction("publish-base-image-manifest");
    const manifestTags = step(
      { steps: manifestAction.runs?.steps },
      "Generate manifest tags",
      "publish-base-image-manifest action",
    );
    expect(manifestTags).toMatchObject({
      id: "meta",
      env: {
        IMAGE: "${{ inputs.registry }}/${{ inputs.image }}",
        REF: "${{ github.ref }}",
        REVISION: "${{ github.sha }}",
      },
      run: 'bash "$GITHUB_ACTION_PATH/tags.sh"',
      shell: "bash",
    });
    expect(
      manifestAction.runs?.steps?.some((candidate) => candidate.uses?.includes("metadata-action")),
    ).toBe(false);
  });
  it("builds and exercises every shipped agent from an exact PR image before merge (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const reviewedAudit = managedPrReviewedAudit(workflow);
    const prBuilder = managedPrBuilder(workflow);
    const matrix = prBuilder.strategy?.matrix?.include ?? [];
    const steps = prBuilder.steps ?? [];
    const permissionDrift = step(prBuilder, "Reproduce reviewed discovery permission drift");
    const releaseIdentity = step(prBuilder, "Resolve managed image release identity");
    const localBaseBuild = step(prBuilder, "Build PR managed image from local base");
    const registryBaseBuild = step(prBuilder, "Build PR managed image from registry base");
    const contract = step(prBuilder, "Validate exact PR managed image contract");
    const publicationIdentity = required(
      workflow.jobs?.["publication-identity"],
      "managed-image workflow is missing its publication identity",
    );
    const publishedContract = step(prBuilder, "Export exact published PR managed-image contract");
    const contractUpload = step(prBuilder, "Upload exact published PR managed-image contract");
    expect(workflow.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        ".github/actions/ci-reviewed-npm-audit/**",
        "ci/reviewed-npm-audit.json",
      ]),
    );
    expect(reviewedAudit).toMatchObject({
      if: "github.event_name == 'pull_request'",
      permissions: { contents: "read" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 25,
    });
    const candidateCheckout = step(reviewedAudit, "Checkout commit under review");
    expect(candidateCheckout.with).toMatchObject({
      ref: "${{ github.event.pull_request.head.sha }}",
      path: "candidate",
      "persist-credentials": false,
    });
    const trustedCheckout = step(reviewedAudit, "Checkout trusted reviewed npm audit");
    expect(trustedCheckout.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      path: ".trusted-reviewed-npm-audit",
      "persist-credentials": false,
      "sparse-checkout-cone-mode": false,
    });
    expect(trustedCheckout.with?.["sparse-checkout"]).toContain(
      ".github/actions/ci-reviewed-npm-audit",
    );
    expect(trustedCheckout.with?.["sparse-checkout"]).toContain("ci/reviewed-npm-audit.json");
    const verifyAuditIdentities = step(reviewedAudit, "Verify exact audit source and target");
    expect(verifyAuditIdentities.env).toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      CANDIDATE_SHA: "${{ github.event.pull_request.head.sha }}",
    });
    expect(verifyAuditIdentities.run).toContain(
      "git -C .trusted-reviewed-npm-audit rev-parse --verify HEAD",
    );
    expect(verifyAuditIdentities.run).toContain("git -C candidate rev-parse --verify HEAD");
    expect(step(reviewedAudit, "Audit exact PR production npm graphs")).toMatchObject({
      uses: "./.trusted-reviewed-npm-audit/.github/actions/ci-reviewed-npm-audit",
      with: {
        "cache-directory": "${{ runner.temp }}/reviewed-npm-audit-cache",
        "report-dir": "artifacts/reviewed-npm-audit",
        "target-root": "${{ github.workspace }}/candidate",
      },
    });
    for (const action of reviewedAudit.steps?.filter((candidate) =>
      candidate.uses?.startsWith("actions/"),
    ) ?? []) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }

    expect(prBuilder.needs).toEqual(["pr-reviewed-npm-audit", "publication-identity"]);
    expect(publicationIdentity.if).toBeUndefined();
    expect(publicationIdentity.outputs).toEqual({
      cohort: "${{ steps.identity.outputs.cohort }}",
    });
    expect(prBuilder.if).toBe("github.event_name == 'pull_request'");
    expect(prBuilder["runs-on"]).toBe("ubuntu-24.04");
    expect(prBuilder["timeout-minutes"]).toBe(90);
    expect(prBuilder.permissions).toEqual({ contents: "read", packages: "write" });
    expect(step(prBuilder, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(prBuilder, "Checkout").with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(releaseIdentity.id).toBe("release");
    expect(releaseIdentity.run).toContain("git describe --tags --match 'v*' \"$CANDIDATE_SHA\"");
    expect(releaseIdentity.run).toContain("value=%s");
    expect(step(prBuilder, "Set up Docker Buildx").id).toBe("buildx");
    const matrixByAgent = new Map(matrix.map((entry) => [entry.agent, entry]));
    expect([...matrixByAgent.keys()].sort()).toEqual([
      "hermes",
      "langchain-deepagents-code",
      "openclaw",
    ]);
    expect(matrix.every(({ base_alias }) => base_alias?.endsWith(":latest"))).toBe(true);
    expect(matrixByAgent.get("openclaw")?.base_dockerfile).toBe(
      "packages/nemoclaw-openclaw/Dockerfile.base",
    );
    expect(matrixByAgent.get("hermes")?.base_dockerfile).toBe("packages/nemoclaw-hermes/Dockerfile.base");
    expect(matrixByAgent.get("langchain-deepagents-code")?.base_dockerfile).toBe(
      "packages/nemoclaw-langchain-deepagents-code/Dockerfile.base",
    );
    expect(steps.indexOf(permissionDrift)).toBeGreaterThan(
      steps.indexOf(step(prBuilder, "Checkout")),
    );
    expect(steps.indexOf(permissionDrift)).toBeLessThan(steps.indexOf(localBaseBuild));
    expect(steps.indexOf(permissionDrift)).toBeLessThan(steps.indexOf(registryBaseBuild));

    for (const action of steps.filter((candidate) => candidate.uses)) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }

    expect(step(prBuilder, "Resolve digest-pinned linux/amd64 PR base").run).toBe(
      "scripts/checks/resolve-managed-pr-base.sh",
    );
    expect(registryBaseBuild.if).toBe("steps.base.outputs.local != 'true'");
    const localBuild = required(localBaseBuild.run, "PR managed image local build is missing");
    expect(localBuild).toContain("docker build");
    expect(localBuild).toContain("--platform linux/amd64");
    expect(localBuild).toContain('--build-arg "BASE_IMAGE=${BASE_IMAGE}"');
    expect(localBuild).toContain('--tag "$IMAGE_REFERENCE"');
    expect(localBuild).toContain('--label "org.opencontainers.image.version=${RELEASE}"');
    expect(localBaseBuild.env?.RELEASE).toBe("${{ steps.release.outputs.value }}");
    expect(localBuild).not.toContain("docker buildx build");
    expect(registryBaseBuild.with).toMatchObject({
      platforms: "linux/amd64",
      load: true,
      push: false,
    });
    expect(registryBaseBuild.with?.labels).toContain(
      "org.opencontainers.image.version=${{ steps.release.outputs.value }}",
    );
    expect(localBaseBuild.env?.PUBLICATION_COHORT).toBe(
      "${{ needs.publication-identity.outputs.cohort }}",
    );
    expect(registryBaseBuild.with?.labels).toContain(
      "io.nvidia.nemoclaw.managed-image.cohort=${{ needs.publication-identity.outputs.cohort }}",
    );
    expect(publishedContract.env?.COHORT).toBe("${{ needs.publication-identity.outputs.cohort }}");
    expect(contractUpload.with).toMatchObject({
      name: "managed-pr-contract-${{ github.run_id }}-${{ matrix.agent }}",
      overwrite: true,
    });
    expect(
      step(managedPrActivation(workflow), "Download exact published all-agent contracts").with
        ?.pattern,
    ).toBe("managed-pr-contract-${{ github.run_id }}-*");
    expect(
      step(managedPrOpenClawMcpDiscovery(workflow), "Download exact published all-agent contracts")
        .with?.pattern,
    ).toBe("managed-pr-contract-${{ github.run_id }}-*");
    expect(contract.env?.RELEASE).toBe("${{ steps.release.outputs.value }}");
    const contractSource = required(contract.run, "PR managed image contract is missing");
    expect(contractSource).toContain(".[0].RootFS.Layers | length");
    expect(contractSource).toContain('[ "$layer_count" -gt 124 ]');
    expect(contractSource).toContain(
      '.[0].Config.Labels["org.opencontainers.image.version"] == $release',
    );
    expect(contractSource).toContain(
      'docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh "$image_id"',
    );
    expect(contractSource).toContain('find -L "$discovery_runtime"');
    expect(contractSource).toContain('find -P "$discovery_runtime" ! -user root');
    expect(contractSource).toContain("\\( ! -user root -o -perm /022 \\) -print -quit");
    expect(contractSource).toContain("-type d ! -perm 0555");
    expect(contractSource).toContain("-type f ! -perm 0444");
    expect(contractSource).toContain('node "$discovery_runtime/mcp-tool-discovery.mjs"');
    expect(contractSource).toContain('result = JSON.parse(require("node:fs").readFileSync(0');
    expect(contractSource).toContain("record.protocol !== expected.protocol");
    expect(contractSource).toContain("record.ok !== expected.ok");
    expect(contractSource).toContain("record.detail !== expected.detail");
    expect(contractSource).not.toContain(
      '[ "$actual_discovery_contract" != "$expected_discovery_contract" ]',
    );
    const contractValidator = inlineNodeStdinValidator(contractSource);

    const permissionDriftSource = required(
      permissionDrift.run,
      "reviewed discovery permission drift fixture is missing",
    );
    const permissionFixture = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-discovery-permission-drift-"),
    );
    const reviewedRoot = path.join(
      permissionFixture,
      "tools",
      "mcp-tool-discovery-runtime",
      "reviewed-runtime-bundle",
      "mcp-tool-discovery",
    );
    const reviewedArtifacts = [
      "BUNDLED_PACKAGES.json",
      "THIRD_PARTY_LICENSES.txt",
      "mcp-tool-discovery.bundle",
    ];
    const permissionDriftScript = path.join(permissionFixture, "permission-drift.sh");
    fs.writeFileSync(permissionDriftScript, permissionDriftSource, { mode: 0o700 });
    fs.mkdirSync(reviewedRoot, { recursive: true });
    for (const artifact of reviewedArtifacts) {
      const source = path.join(
        repoRoot,
        "tools",
        "mcp-tool-discovery-runtime",
        "reviewed-runtime-bundle",
        "mcp-tool-discovery",
        artifact,
      );
      const fixture = path.join(reviewedRoot, artifact);
      fs.copyFileSync(source, fixture);
      fs.chmodSync(fixture, 0o444);
    }
    try {
      const drifted = spawnSync("bash", [permissionDriftScript], {
        cwd: permissionFixture,
        encoding: "utf8",
      });
      expect(drifted.status, drifted.stderr).toBe(0);
      expect(drifted.stdout).toBe("");
      expect(drifted.stderr).toBe("");
      for (const artifact of reviewedArtifacts) {
        expect(fs.statSync(path.join(reviewedRoot, artifact)).mode & 0o777).toBe(0o664);
      }

      const executableBundle = path.join(permissionFixture, "mcp-tool-discovery.mjs");
      fs.copyFileSync(path.join(reviewedRoot, "mcp-tool-discovery.bundle"), executableBundle);
      const bundleResult = spawnSync(process.execPath, [executableBundle], { encoding: "utf8" });
      expect(bundleResult.status, bundleResult.stderr).toBe(0);
      expect(JSON.parse(bundleResult.stdout)).toMatchObject({
        protocol: 1,
        ok: false,
        count: 0,
        tools: [],
        truncated: false,
        detail: "tool discovery received invalid runtime arguments",
      });
      const acceptedContract = spawnSync(process.execPath, ["-e", contractValidator], {
        encoding: "utf8",
        input: bundleResult.stdout,
      });
      expect(acceptedContract.status, acceptedContract.stderr).toBe(0);
      for (const rejectedOutput of [
        '{"protocol":1,"ok":false,"detail":"wrong"}\n',
        '{"protocol":1,"ok":false,"detail":"tool discovery received invalid runtime arguments","extra":NaN}\n',
        '\uFEFF{"protocol":1,"ok":false,"detail":"tool discovery received invalid runtime arguments"}\n',
      ]) {
        const rejectedContract = spawnSync(process.execPath, ["-e", contractValidator], {
          encoding: "utf8",
          input: rejectedOutput,
        });
        expect(rejectedContract.status).not.toBe(0);
      }

      const linkedArtifact = path.join(reviewedRoot, reviewedArtifacts[0]);
      const externalArtifact = path.join(permissionFixture, "external-reviewed-artifact.json");
      fs.unlinkSync(linkedArtifact);
      fs.writeFileSync(externalArtifact, "{}\n", { mode: 0o444 });
      fs.symlinkSync(externalArtifact, linkedArtifact);
      const rejected = spawnSync("bash", [permissionDriftScript], {
        cwd: permissionFixture,
        encoding: "utf8",
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain(
        "ERROR: reviewed discovery permission fixture must be a regular non-symlink:",
      );
      expect(fs.statSync(externalArtifact).mode & 0o777).toBe(0o444);
    } finally {
      fs.rmSync(permissionFixture, { recursive: true, force: true });
    }

    expect(step(prBuilder, "Exercise managed startup root stdin and hold").run).toContain(
      "run-managed-image-direct-e2e.ts",
    );
    const login = step(prBuilder, "Log in to GHCR for exact same-repository PR digest");
    const publish = step(prBuilder, "Publish exact same-repository PR managed image by digest");
    const logout = step(prBuilder, "Remove PR publication credentials");
    const exportContract = step(prBuilder, "Export exact published PR managed-image contract");
    const uploadContract = step(prBuilder, "Upload exact published PR managed-image contract");
    const sameRepository = "github.event.pull_request.head.repo.full_name == github.repository";
    expect(login.if).toBe(sameRepository);
    expect(publish.if).toBe(sameRepository);
    expect(publish.with).toMatchObject({
      builder: "${{ steps.buildx.outputs.name }}",
      platforms: "linux/amd64",
      "build-contexts":
        "${{ steps.base.outputs.local == 'true' && format('nemoclaw-pr-base=oci-layout://{0}', steps.base.outputs.oci) || '' }}",
      outputs:
        "type=image,name=${{ matrix.repository }},push-by-digest=true,name-canonical=true,push=true",
      provenance: false,
      sbom: false,
    });
    expect(publish.with?.["build-args"]).toContain(
      "BASE_IMAGE=${{ steps.base.outputs.local == 'true' && 'nemoclaw-pr-base' || steps.base.outputs.ref }}",
    );
    expect(publish.with?.labels).toContain(
      "org.opencontainers.image.version=${{ steps.release.outputs.value }}",
    );
    expect(publish.with?.tags).toBeUndefined();
    expect(logout.if).toContain(sameRepository);
    expect(exportContract.if).toBe(sameRepository);
    expect(uploadContract.if).toBe(sameRepository);
    expect(steps.indexOf(logout)).toBeLessThan(steps.indexOf(exportContract));
    const exportContractRun = exportContract.run ?? "";
    expect(exportContractRun).toContain("scripts/checks/pull-public-exact-digest.sh");
    expect(exportContractRun.indexOf("scripts/checks/pull-public-exact-digest.sh")).toBeLessThan(
      exportContractRun.indexOf('docker buildx imagetools inspect "$reference" --raw'),
    );
    expect(exportContract.env?.RELEASE).toBe("${{ steps.release.outputs.value }}");
    expect(exportContractRun).toContain("org.opencontainers.image.version");
    expect(exportContractRun).toContain('--arg release "$RELEASE"');
    expect(exportContractRun).not.toContain("git describe --tags");
    expect(exportContractRun).toContain("revision: $revision");
    expect(JSON.stringify(prBuilder).match(/secrets\.GITHUB_TOKEN/gu)).toHaveLength(1);
    expect(JSON.stringify(prBuilder)).not.toContain("github.token");
  });

  it("runs the exact candidate CLI through real all-agent Docker and OpenShell activation (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const activation = managedPrActivation(workflow);
    const steps = activation.steps ?? [];

    expect(workflow.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        "src/lib/onboard/**",
        "test/e2e/live/managed-image-activation-e2e*.ts",
      ]),
    );
    expect(activation.needs).toBe("pr-build-and-entrypoint");
    expect(activation.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(activation.permissions).toEqual({ contents: "read" });
    expect(activation.env?.CANDIDATE_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(activation.env?.NEMOCLAW_MANAGED_ACTIVATION_CATALOG).toBe(
      "${{ github.workspace }}/managed-pr-catalog.json",
    );
    expect(JSON.stringify(activation)).not.toContain("secrets.");
    expect(JSON.stringify(activation)).not.toContain("github.token");
    expect(step(activation, "Checkout exact PR head").with?.ref).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
    expect(step(activation, "Assemble exact all-agent activation catalog").run).toMatch(
      /npm ci --ignore-scripts --no-audit --no-fund[\s\S]*pr-managed-image-publication\.mts assemble[\s\S]*"\$CANDIDATE_SHA"[\s\S]*"\$\{contracts\[@\]\}"/u,
    );
    expect(step(activation, "Build exact candidate CLI").run).toContain("npm run build:cli");
    expect(step(activation, "Install OpenShell CLI").run).toContain("scripts/install-openshell.sh");
    const run = step(activation, "Run real all-agent managed runtime activation").run ?? "";
    expect(run).toContain('[[ "$(git rev-parse --verify HEAD)" == "$CANDIDATE_SHA" ]]');
    expect(run).toContain("test/e2e/live/managed-image-activation-e2e.test.ts");
    expect(steps.map(({ name }) => name)).toContain("Upload managed runtime activation evidence");
  });

  it("passes the reported OpenClaw managed-image MCP discovery twice on one exact PR cohort (#8746)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const discovery = managedPrOpenClawMcpDiscovery(workflow);
    const stableMcp = required(
      readWorkflow("e2e.yaml").jobs?.["mcp-bridge"],
      "unified E2E workflow is missing its stable MCP job",
    );
    expect(workflow.on?.pull_request?.paths).toContain("test/e2e/live/mcp-bridge*.ts");
    expect(discovery.needs).toBe("pr-build-and-entrypoint");
    expect(discovery.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(discovery.permissions).toEqual({ contents: "read" });
    expect(discovery.strategy?.["fail-fast"]).toBe(false);
    expect(discovery.strategy?.matrix?.pass).toEqual([1, 2]);
    expect(discovery.env?.CANDIDATE_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(discovery.env?.NEMOCLAW_E2E_EXPECTED_SHA).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
    expect(discovery.env?.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG).toContain("managed-pr-catalog.json");
    expect(discovery.env?.NEMOCLAW_MCP_BRIDGE_AGENT).toBe("openclaw");
    expect(discovery.env?.NEMOCLAW_MCP_BRIDGE_E2E_SCOPE).toBe("managed-image-discovery");
    expect(discovery.env?.NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST).toBe("1");
    expect(discovery.env?.NEMOCLAW_E2E_SHARD).toBe("openclaw");
    expect(discovery.env?.NEMOCLAW_RUN_LIVE_E2E).toBe("1");
    const stableSupervisorImage = required(
      stableMcp.env?.OPENSHELL_DOCKER_SUPERVISOR_IMAGE,
      "stable MCP job is missing OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
    );
    const discoverySupervisorImage = required(
      discovery.env?.OPENSHELL_DOCKER_SUPERVISOR_IMAGE,
      "OpenClaw MCP discovery is missing OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
    );
    expect(discoverySupervisorImage).toBe(stableSupervisorImage);
    expect(discovery.env).not.toHaveProperty("E2E_MANAGED_IMAGE_REVISION");
    expect(JSON.stringify(discovery)).not.toContain("secrets.");
    expect(JSON.stringify(discovery)).not.toContain("github.token");
    expect(step(discovery, "Checkout exact PR head").with?.ref).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
    expect(step(discovery, "Bind E2E correlation identity").run).toContain("randomUUID()");
    const assemble = step(discovery, "Assemble exact all-agent MCP catalog").run ?? "";
    expect(assemble).toMatch(
      /npm ci --ignore-scripts --no-audit --no-fund[\s\S]*pr-managed-image-publication\.mts assemble[\s\S]*"\$CANDIDATE_SHA"[\s\S]*"\$\{contracts\[@\]\}"/u,
    );
    const run = step(discovery, "Run exact OpenClaw managed-image MCP discovery").run ?? "";
    expect(run).toContain('[[ "$(git rev-parse --verify HEAD)" == "$CANDIDATE_SHA" ]]');
    expect(JSON.stringify(discovery)).not.toContain("jq ");
    expect(run).toMatch(/npx --no-install tsx[\s\S]*test\/e2e\/live\/mcp-bridge\.test\.ts/u);
    expect(run).not.toContain("--selector");
    expect(step(discovery, "Scan MCP artifacts for fixture credentials").if).toBe("always()");
  });

  it("pins a single linux/amd64 PR base descriptor and fails closed on torn index evidence", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const resolver = required(
      step(managedPrBuilder(workflow), "Resolve digest-pinned linux/amd64 PR base").run,
      "PR base resolver script is missing",
    );
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-base-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const aliasRaw = path.join(temporaryRoot, "alias.raw");
    const exactRaw = path.join(temporaryRoot, "exact.raw");
    const output = path.join(temporaryRoot, "output");
    const summary = path.join(temporaryRoot, "summary");
    fs.mkdirSync(fakeBin);
    const exactBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"a".repeat(64)}`, size: 1 },
      layers: [],
    });
    const digest = `sha256:${createHash("sha256").update(exactBody).digest("hex")}`;
    const descriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: exactBody.length,
      platform: { os: "linux", architecture: "amd64" },
    };
    const writeAlias = (manifests: unknown[]) => {
      fs.writeFileSync(
        aliasRaw,
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests,
        }),
      );
    };
    writeAlias([descriptor]);
    fs.writeFileSync(exactRaw, exactBody);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/bin/bash
set -euo pipefail
if [ "\${1:-} \${2:-} \${3:-}" != "buildx imagetools inspect" ]; then
  exit 90
fi
if [[ "\${4:-}" == *":latest" ]]; then
  cat "$ALIAS_RAW"
else
  cat "$EXACT_RAW"
fi
`,
      { mode: 0o755 },
    );
    const runResolver = () =>
      spawnSync("bash", ["-c", resolver], {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT: "openclaw",
          ALIAS_RAW: aliasRaw,
          BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
          BASE_DOCKERFILE: "packages/nemoclaw-openclaw/Dockerfile.base",
          BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/sandbox-base",
          BASE_SHA: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
          CANDIDATE_SHA: spawnSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).stdout.trim(),
          DISPLAY_NAME: "OpenClaw",
          EXACT_RAW: exactRaw,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/openclaw-base:test",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });

    try {
      const accepted = runResolver();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain(
        `ref=ghcr.io/nvidia/nemoclaw/sandbox-base@${digest}`,
      );

      writeAlias([descriptor, descriptor]);
      const duplicate = runResolver();
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain("does not contain exactly one linux/amd64 image");

      writeAlias([descriptor]);
      fs.appendFileSync(exactRaw, " ");
      const wrongBody = runResolver();
      expect(wrongBody.status).not.toBe(0);
      expect(wrongBody.stderr).toContain(
        "exact PR base bytes do not match the selected descriptor digest",
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("publishes an exact native amd64 and arm64 lane for every shipped agent (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = managedBuilder(workflow);

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["pull_request", "workflow_call"]);
    expect(workflow.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(builder.if).toBe("github.event_name != 'pull_request'");
    expect(builder["runs-on"]).toBe("${{ matrix.runner }}");
    expect(builder["timeout-minutes"]).toBe(120);
    expect(builder.strategy?.["fail-fast"]).toBe(false);
    expect(builder.strategy?.matrix?.include).toEqual([
      {
        agent: "openclaw",
        arch: "amd64",
        display_name: "OpenClaw",
        dockerfile: "packages/nemoclaw-openclaw/Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/openclaw",
        runner: "ubuntu-24.04",
      },
      {
        agent: "openclaw",
        arch: "arm64",
        display_name: "OpenClaw",
        dockerfile: "packages/nemoclaw-openclaw/Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/openclaw",
        runner: "ubuntu-24.04-arm",
      },
      {
        agent: "hermes",
        arch: "amd64",
        display_name: "Hermes",
        dockerfile: "packages/nemoclaw-hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/hermes",
        runner: "ubuntu-24.04",
      },
      {
        agent: "hermes",
        arch: "arm64",
        display_name: "Hermes",
        dockerfile: "packages/nemoclaw-hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/hermes",
        runner: "ubuntu-24.04-arm",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "amd64",
        display_name: "Deep Agents Code",
        dockerfile: "packages/nemoclaw-langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/dcode",
        runner: "ubuntu-24.04",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "arm64",
        display_name: "Deep Agents Code",
        dockerfile: "packages/nemoclaw-langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/dcode",
        runner: "ubuntu-24.04-arm",
      },
    ]);
    expect(
      builder.strategy?.matrix?.include?.map(({ agent, platform }) => `${agent}|${platform}`),
    ).toEqual(
      publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => `${agent}|${platform}`),
      ),
    );
  });

});
