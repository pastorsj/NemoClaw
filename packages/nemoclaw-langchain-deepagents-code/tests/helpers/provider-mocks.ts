// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function commandArguments(command: string | readonly string[]): string[] {
  const normalized = (Array.isArray(command) ? command.join(" ") : String(command)).replaceAll(
    "'",
    "",
  );
  return normalized.split(/\s+/);
}

function mockEndpointlessProviderProfile(
  command: string | readonly string[],
  profileId: string,
  inferenceCapable: boolean,
): CommandResult | null {
  const args = commandArguments(command);
  const providerIndex = args.indexOf("provider");
  if (providerIndex < 0 || args[providerIndex + 1] !== "profile") return null;

  const actionIndex = providerIndex + 2;
  const action = args[actionIndex] === "-g" ? args[actionIndex + 2] : args[actionIndex];
  if (action === "export") {
    const requestedProfile = args[args.indexOf("export") + 1];
    if (requestedProfile !== profileId) return null;
    return {
      status: 0,
      stdout: JSON.stringify({
        id: profileId,
        credentials: [],
        endpoints: [],
        binaries: [],
        inference_capable: inferenceCapable,
      }),
      stderr: "",
    };
  }

  const fileIndex = args.indexOf("--file");
  if (
    action === "import" &&
    (fileIndex < 0 || !String(args[fileIndex + 1] ?? "").endsWith(`/${profileId}.yaml`))
  ) {
    return null;
  }
  return action === "import"
    ? { status: 0, stdout: "", stderr: "" }
    : { status: 1, stdout: "", stderr: "unsupported provider profile command" };
}

export function mockManagedEndpointlessProviderProfile(
  command: string | readonly string[],
): CommandResult | null {
  return (
    mockEndpointlessProviderProfile(command, "openai", true) ??
    mockEndpointlessProviderProfile(command, "nemoclaw-mcp-v1", false)
  );
}
