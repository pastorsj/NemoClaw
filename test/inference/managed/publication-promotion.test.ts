// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  managedPromoter,
  managedPublisher,
  readAction,
  readWorkflow,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";

const fullShaAction = /^[^@]+@[0-9a-f]{40}$/iu;

describe("complete managed-image publication workflow", () => {
  it("pins actions, validates exact digests, and records the immutable image contract (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const promoter = managedPromoter(workflow);
    const steps = publisher.steps ?? [];

    [...steps, ...(promoter.steps ?? [])]
      .filter((candidate) => candidate.uses && !candidate.uses.startsWith("./"))
      .forEach((action) => {
        expect(action.uses, action.name).toMatch(fullShaAction);
      });
    expect(step(publisher, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(publisher, "Checkout").with?.["fetch-depth"]).toBe(0);
    const restoreBase = step(publisher, "Restore exact base image contract");
    expect(restoreBase.run).toContain('base64 --decode > "$contract_root/contract.json"');
    expect(restoreBase.env?.OPENCLAW_CONTRACT_BASE64).toBe(
      "${{ inputs.openclaw-base-contract-base64 }}",
    );
    const canonicalBase = runManagedImageBaseRestore(
      restoreBase.run ?? "",
      Buffer.from("{}\n").toString("base64"),
    );
    expect(canonicalBase.status, canonicalBase.stderr).toBe(0);
    expect(canonicalBase.restored).toBe(true);
    const noncanonicalBase = runManagedImageBaseRestore(restoreBase.run ?? "", "TR==");
    expect(noncanonicalBase.status).not.toBe(0);
    expect(noncanonicalBase.restored).toBe(false);
    expect(noncanonicalBase.stderr).toContain(
      "exact base image producer output is not canonical base64",
    );
    expect(noncanonicalBase.stderr).not.toContain("TR==");

    const guard = step(publisher, "Validate production build args");
    const releaseIdentity = step(publisher, "Resolve managed image release identity");
    const validate = step(publisher, "Validate exact managed image before promotion");
    const evidence = step(publisher, "Capture exact managed image publication evidence");
    const dependencies = step(publisher, "Install managed-image publication harness dependencies");
    expect(dependencies.run).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(releaseIdentity.id).toBe("release");
    expect(releaseIdentity.run).toContain("git describe --tags --match 'v*' \"$GITHUB_SHA\"");
    expect(releaseIdentity.run).toContain("managed image release identity does not match");
    expect(guard.run).toContain('--build-arg "TARGETARCH=${target_arch}"');
    expect(guard.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');

    const base = step(publisher, "Validate exact base image contract");
    expect(base.run).toContain(".platformReferences[$platform]");
    expect(base.run).toContain('imagetools inspect "$platform_reference"');

    const contract = step(publisher, "Export validated managed image candidate");
    const contractMarkers = [
      "--arg baseReference",
      "--arg digest",
      "--arg platform",
      "--arg cohort",
      "--arg revision",
      "--argjson runAttempt",
      "--argjson runId",
      "contractVersion: 2",
      'phase: "candidate"',
      "--slurpfile publicationEvidence",
      "publicationEvidence: $publicationEvidence[0]",
      "https://slsa.dev/provenance/v1",
      "https://spdx.dev/Document",
    ];
    expect(contractMarkers.filter((marker) => contract.run?.includes(marker) !== true)).toEqual([]);
    expect(step(publisher, "Upload validated managed image candidate").with).toMatchObject({
      name: "managed-image-candidate-${{ github.run_id }}-${{ matrix.agent }}-${{ matrix.artifact_platform }}",
      path: "${{ runner.temp }}/managed-image-candidate/contract.json",
      "if-no-files-found": "error",
      overwrite: true,
      "retention-days": 1,
    });
    const validation = required(validate.run, "managed image validation script is missing");
    expect(validate.env?.RELEASE).toBe("${{ steps.release.outputs.value }}");
    expect(validation).toContain('release_label="$(');
    expect(validation).toContain('[ "$release_label" != "$RELEASE" ]');
    expect(validation.match(/docker run/g)).toHaveLength(2);
    expect(validation).toContain("run-managed-image-direct-e2e.ts");
    expect(validation).toContain("npx --no-install tsx");
    expect(validation).toContain('metadata.version("agent-client-protocol") != "0.9.0"');
    expect(validation).toContain("/usr/local/bin/hermes acp --check");
    expect(validation).toContain('--image "$reference"');
    expect(validation).toContain("printf 'local_id=%s\\n' \"$image_id\"");
    expect(validation).not.toContain("NEMOCLAW_STARTUP_PROFILE_B64");
    expect(validation).not.toContain("NEMOCLAW_CORPORATE_CA_B64");
    expect(validation).not.toContain(".Config.Entrypoint");
    expect(validation).not.toContain(".Config.Cmd");
    expect(evidence.run).toContain("verify-managed-image-publication-evidence.sh");
    expect(evidence.run).toContain('--reference "$REFERENCE"');
    expect(evidence.run).toContain('--digest "$DIGEST"');
    expect(evidence.run).toContain('--platform "$PLATFORM"');
    expect(evidence.run).toContain('--agent "$AGENT"');
    expect(evidence.run).toContain('--base-reference "$BASE_REFERENCE"');
    expect(evidence.run).toContain('--repository "$GITHUB_REPOSITORY"');
    expect(evidence.run).toContain('--revision "$GITHUB_SHA"');
    expect(evidence.run).toContain('--cohort "$COHORT"');
    expect(evidence.run).toContain('--run-id "$GITHUB_RUN_ID"');
    expect(evidence.run).toContain('--run-attempt "$GITHUB_RUN_ATTEMPT"');
    expect(steps.indexOf(dependencies)).toBeLessThan(steps.indexOf(validate));
    expect(steps.indexOf(validate)).toBeLessThan(steps.indexOf(evidence));
    expect(steps.indexOf(evidence)).toBeLessThan(steps.indexOf(contract));
  });

  it("cannot publish a public mutable alias from an individual agent lane (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const steps = publisher.steps ?? [];
    const source = steps.map((candidate) => candidate.run ?? "").join("\n");
    const contract = step(publisher, "Export validated managed image candidate");

    expect(publisher.strategy?.matrix?.include).toHaveLength(6);
    expect(steps.map((candidate) => candidate.name)).not.toContain(
      "Promote validated managed image aliases",
    );
    expect(source).not.toContain('aliases=("${IMAGE}:${GITHUB_SHA}")');
    expect(source).not.toContain("docker buildx imagetools create");
    expect(source).not.toMatch(/(?:^|\s)docker\s+(?:tag|push)\s/u);
    expect(contract.run).toContain('(has("aliases") | not)');
    expect(contract.run).not.toContain("aliases:");
  });

  it("binds non-PR OpenClaw publication to same-run reviewed audit evidence", () => {
    const workflow = readWorkflow("managed-images.yaml"),
      publisher = managedPublisher(workflow),
      action = readAction("publish-managed-image-digest"),
      source = JSON.stringify(workflow);
    expect(workflow.jobs?.["reviewed-npm-audit"]?.if).toBe("github.event_name != 'pull_request'");
    expect(publisher.needs).toEqual(["publication-identity", "reviewed-npm-audit"]);
    expect(
      [
        "Download same-run reviewed npm audit evidence",
        "Prepare same-run mcporter audit evidence",
        "mcporter-runtime.receipt.json",
        "mcporter-runtime.raw.json",
        "nemoclaw-mcporter-audit-receipt",
        "nemoclaw-mcporter-audit-raw-report",
        "NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256",
      ].filter((marker) => !source.includes(marker)),
    ).toEqual([]);
    expect(source).not.toContain("NEMOCLAW_MCPORTER_AUDIT_RAW_REPORT_SHA256");
    const actionSource = JSON.stringify(action);
    expect([
      actionSource.includes('"secret-files":{"description"'),
      actionSource.includes('"secret-files":"${{ inputs.secret-files }}"'),
    ]).toEqual([true, true]);
  });
  it("holds every alias behind the exact six-candidate aggregate barrier (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const identity = workflow.jobs?.["publication-identity"];
    const publisher = managedPublisher(workflow);
    const promoter = managedPromoter(workflow);
    const steps = promoter.steps ?? [];
    const restoreCandidates = step(promoter, "Restore all validated managed image candidates");
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const revalidate = step(promoter, "Revalidate exact managed image publication evidence");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const pointer = step(promoter, "Promote durable managed image cohort pointers");
    const durableUploads = steps.filter(
      (candidate) =>
        candidate.uses?.startsWith("actions/upload-artifact@") &&
        String(candidate.with?.name ?? "").startsWith("managed-image-"),
    );

    expect(identity?.outputs).toEqual({ cohort: "${{ steps.identity.outputs.cohort }}" });
    expect(publisher.needs).toEqual(["publication-identity", "reviewed-npm-audit"]);
    expect(publisher.outputs).toBeUndefined();
    expect(publisher.steps?.map((candidate) => candidate.name)).not.toContain(
      "Export validated managed image candidate output",
    );
    expect(promoter.needs).toEqual(["publication-identity", "build-and-validate"]);
    expect(restoreCandidates).toMatchObject({
      uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      with: {
        pattern: "managed-image-candidate-${{ github.run_id }}-*",
        path: "${{ runner.temp }}/managed-image-candidates",
      },
    });
    expect(barrier.env?.PUBLICATION_COHORT).toBe(
      "${{ needs.publication-identity.outputs.cohort }}",
    );
    expect(barrier.run).toContain("expected exactly six managed image candidate artifacts");
    expect(barrier.run).toContain("managed image candidate producer attempt is invalid");
    expect(barrier.run).toContain('expected_attempts+=("$expected_attempt")');
    expect(barrier.run).toContain("length == 6");
    expect(barrier.run).toContain('([.[].platform] | sort) == ["linux/amd64", "linux/arm64"]');
    expect(barrier.run).toContain("([.[].reference] | unique | length) == 6");
    expect(barrier.run).toContain("([.[].baseReference] | unique | length) == 6");
    expect(barrier.run).toContain("publicationEvidence.workloadDescriptor.digest");
    expect(barrier.run).toContain("publicationEvidence.attestations.manifestDescriptor.digest");
    expect(barrier.run).toContain("https://slsa.dev/provenance/v1");
    expect(barrier.run).toContain("https://in-toto.io/Statement/v1");
    expect(barrier.run).toContain("publicationEvidence.attestations.slsa.statement");
    expect(barrier.run).toContain("publicationEvidence.attestations.spdx.statement");
    expect(barrier.run).toContain("https://spdx.dev/Document");
    expect(barrier.run).not.toContain("docker buildx imagetools create");
    expect(revalidate.run).toContain("verify-managed-image-publication-evidence.sh");
    expect(revalidate.run).toContain('--base-reference "$base_reference"');
    expect(revalidate.run).toContain('--run-attempt "$run_attempt"');
    expect(revalidate.run).toContain("registry publication evidence changed");
    expect(steps.indexOf(barrier)).toBeLessThan(steps.indexOf(promotion));
    expect(steps.indexOf(revalidate)).toBeLessThan(steps.indexOf(promotion));
    expect(durableUploads.map((upload) => upload.with)).toEqual([
      {
        name: "managed-image-cohort-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/managed-image-contracts/cohort.json",
        "if-no-files-found": "error",
        "retention-days": 90,
      },
      ...publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => ({
          name:
            "managed-image-${{ github.run_id }}-${{ github.run_attempt }}-" +
            `${agent}-${platform.replaceAll("/", "-")}`,
          path: `\${{ runner.temp }}/managed-image-contracts/${agent}/${platform.replaceAll("/", "-")}/contract.json`,
          "if-no-files-found": "error",
          "retention-days": 90,
        })),
      ),
    ]);
    durableUploads.forEach((upload) => {
      expect(steps.indexOf(promotion)).toBeLessThan(steps.indexOf(upload));
      expect(steps.indexOf(upload)).toBeLessThan(steps.indexOf(pointer));
    });

    expect(promotion.run).toContain("for agent in openclaw hermes langchain-deepagents-code");
    expect(promotion.run).toContain('--metadata-file "$cohort_metadata"');
    expect(promotion.run).toContain('"${descriptor_args[@]}"');
    expect(promotion.run).toContain('cmp -s "$expected_descriptors" "$actual_descriptors"');
    expect(promotion.run).toContain(') == ["linux/amd64", "linux/arm64"]');
    expect(promotion.run).toContain(
      'consumer_aliases=("$(jq -r \'.image\' <<<"$openclaw_manifest"):${GITHUB_SHA}")',
    );
    expect(promotion.run).not.toContain('imagetools create "${consumer_tag_args[@]}"');
    expect(pointer.run).toContain("exact_reference=\"$(jq -er '.agents.openclaw.reference'");
    expect(pointer.run).toContain('imagetools create "${consumer_tag_args[@]}" "$exact_reference"');
    expect(pointer.run).toContain('cmp -s "$exact_raw" "$alias_raw"');
    expect(pointer.run).not.toContain("$openclaw_alias");
    expect(promotion.run).not.toContain(":latest");
  });

  it("fails the barrier before alias code when either architecture is absent (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => candidates.slice(0, -1),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exactly six managed image candidate artifacts");
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails the barrier before alias code on a duplicated architecture (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate) =>
          candidate.artifact === "managed-image-candidate-7744-openclaw-linux-arm64"
            ? {
                ...candidate,
                contract: { ...candidate.contract, platform: "linux/amd64" },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate artifact identity is invalid");
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails the barrier before alias code on a mixed-run cohort (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate, index) =>
          index === 0
            ? {
                ...candidate,
                contract: {
                  ...candidate.contract,
                  source: {
                    ...(candidate.contract.source as Record<string, unknown>),
                    revision: "b".repeat(40),
                  },
                },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails closed before alias code when a candidate omits real SPDX evidence", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => {
        const candidate = candidates[0]!;
        const contract = structuredClone(candidate.contract);
        const evidence = contract.publicationEvidence as Record<string, unknown>;
        const attestations = evidence.attestations as Record<string, unknown>;
        delete attestations.spdx;
        return [{ ...candidate, contract }, ...candidates.slice(1)];
      },
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
  });

  it("fails closed before alias code on mixed workload and attestation descriptors", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => {
        const candidate = candidates[0]!;
        const contract = structuredClone(candidate.contract);
        const evidence = contract.publicationEvidence as Record<string, unknown>;
        const attestations = evidence.attestations as Record<string, unknown>;
        const manifest = attestations.manifestDescriptor as Record<string, unknown>;
        const annotations = manifest.annotations as Record<string, unknown>;
        annotations["vnd.docker.reference.digest"] = `sha256:${"f".repeat(64)}`;
        return [{ ...candidate, contract }, ...candidates.slice(1)];
      },
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
  });

  it("accepts one exact candidate for every agent and architecture (#7744)", () => {
    const barrier = step(
      managedPromoter(readWorkflow("managed-images.yaml")),
      "Validate complete managed image candidate set",
    );

    expect(runPublicationBarrier(barrier.run ?? "").status).toBe(0);
    const mixedAttempts = runPublicationBarrier(
      barrier.run ?? "",
      reuseOpenclawAmd64FromAttemptOne,
      "",
      {
        publicationCohort: "ghrun-7744-1",
      },
    );
    expect(mixedAttempts.status, mixedAttempts.stderr).toBe(0);
    const futureCohort = runPublicationBarrier(barrier.run ?? "", (value) => value, "", {
      publicationCohort: "ghrun-7744-3",
    });
    expect(futureCohort.status).not.toBe(0);
    expect(futureCohort.stderr).toContain("publication cohort is invalid");
    expect(futureCohort.dockerCalls).toEqual([]);
    const wrongRunCohort = runPublicationBarrier(barrier.run ?? "", (value) => value, "", {
      publicationCohort: "ghrun-8877-1",
    });
    expect(wrongRunCohort.status).not.toBe(0);
    expect(wrongRunCohort.stderr).toContain("publication cohort is invalid");
    expect(wrongRunCohort.dockerCalls).toEqual([]);
  });

  it.each([0, 3])("rejects producer attempt %s without publishing aliases", (producerAttempt) => {
    const barrier = step(
      managedPromoter(readWorkflow("managed-images.yaml")),
      "Validate complete managed image candidate set",
    );
    const invalidAttempt = runPublicationBarrier(barrier.run ?? "", (candidates) => {
      const candidate = candidates[0]!;
      return [
        {
          ...candidate,
          contract: {
            ...candidate.contract,
            run: { id: 7744, attempt: producerAttempt },
          },
        },
        ...candidates.slice(1),
      ];
    });

    expect(invalidAttempt.status).not.toBe(0);
    expect(invalidAttempt.stderr).toContain("candidate producer attempt is invalid");
    expect(invalidAttempt.dockerCalls).toEqual([]);
  });

  it("stages all multi-platform cohort aliases before moving the sole root pointer (#7744)", () => {
    const promotion = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Stage validated multi-platform managed image cohort and contracts",
      ).run,
      "managed image promotion script is missing",
    );
    const pointer = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Promote durable managed image cohort pointers",
      ).run,
      "managed image pointer script is missing",
    );
    const cohort = "ghrun-7744-2";
    const revision = "a".repeat(40);

    const failed = runManagedImagePromotion(promotion, "langchain-deepagents-code");
    const failedCalls = failed.calls.join("\n");
    expect(failed.status, failed.stderr).toBe(91);
    expect(failedCalls).toContain(`hermes-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`langchain-deepagents-code-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`openclaw-sandbox:cohort-${cohort}`);
    expect(failedCalls).not.toContain(`openclaw-sandbox:${revision}`);

    const accepted = runManagedImagePromotion(promotion, "", pointer);
    const acceptedCalls = accepted.calls.join("\n");
    expect(accepted.status, accepted.stderr).toBe(0);
    const cohortAgents = (accepted.cohortContract?.agents ?? {}) as Record<
      string,
      { reference?: string }
    >;
    const expectedPullCalls = publicationAgents.flatMap((agent) => {
      const reference = cohortAgents[agent]?.reference;
      expect(reference).toMatch(/^ghcr\.io\/nvidia\/nemoclaw\/.+@sha256:[0-9a-f]{64}$/u);
      return publicationPlatforms.map((platform) => `pull --platform ${platform} ${reference}`);
    });
    const lastCohortStage = Math.max(
      acceptedCalls.indexOf(`hermes-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`langchain-deepagents-code-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`openclaw-sandbox:cohort-${cohort}`),
    );
    const rootPointer = acceptedCalls.indexOf(`openclaw-sandbox:${revision}`);

    expect(accepted.calls.filter((call) => call.startsWith("pull ")).sort()).toEqual(
      expectedPullCalls.sort(),
    );
    expectedPullCalls.forEach((pull) => {
      const index = accepted.calls.indexOf(pull);
      const reference = pull.match(/^pull --platform linux\/(?:amd64|arm64) (.+)$/u)?.[1];
      expect(reference).toBeDefined();
      expect(index).toBeGreaterThanOrEqual(0);
      expect(accepted.calls[index + 1]).toBe(`image rm ${reference}`);
    });
    expect(lastCohortStage).toBeGreaterThanOrEqual(0);
    expect(rootPointer).toBeGreaterThan(lastCohortStage);
    expect(acceptedCalls).not.toContain(`hermes-sandbox:${revision}`);
    expect(acceptedCalls).not.toContain(`langchain-deepagents-code-sandbox:${revision}`);
    expect(Object.keys(accepted.platformContracts).sort()).toEqual(
      publicationAgents
        .flatMap((agent) => publicationPlatforms.map((platform) => `${agent}|${platform}`))
        .sort(),
    );
    expect(accepted.cohortContract).toMatchObject({
      contractVersion: 2,
      cohort,
      platforms: ["linux/amd64", "linux/arm64"],
      agents: {
        openclaw: expect.objectContaining({
          descriptor: expect.objectContaining({
            mediaType: "application/vnd.oci.image.index.v1+json",
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          }),
          platforms: expect.objectContaining({
            "linux/amd64": expect.objectContaining({
              publicationEvidence: expect.objectContaining({
                workloadDescriptor: expect.any(Object),
                attestations: expect.any(Object),
              }),
            }),
            "linux/arm64": expect.any(Object),
          }),
        }),
        hermes: expect.any(Object),
        "langchain-deepagents-code": expect.any(Object),
      },
    });

    const reusedKey = "openclaw|linux/amd64";
    const mixedPromotion = runManagedImagePromotion(promotion, "", "", {
      mutate: reuseOpenclawAmd64FromAttemptOne,
      publicationCohort: "ghrun-7744-1",
    });
    expect(mixedPromotion.status, mixedPromotion.stderr).toBe(0);
    expect(mixedPromotion.platformContracts[reusedKey]?.run).toEqual({ id: 7744, attempt: 1 });
  });
});
