# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for native Fabric configuration loading."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nemoclaw_fabric.config import FabricConfigLoadError
from nemoclaw_fabric.config import FABRIC_CONFIG_MAX_BYTES
from nemoclaw_fabric.config import SUPERVISOR_CONFIG_SHA256_ENV
from nemoclaw_fabric.config import load_fabric_config
from nemoclaw_fabric.config import require_supervisor_config_identity


class FabricConfigLoadingTests(unittest.TestCase):
    """Keep the runner generic by delegating schema ownership to Fabric."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.config_path = self.base_dir / "fabric.json"

    def write_config(self, payload: object) -> Path:
        self.config_path.write_text(json.dumps(payload), encoding="utf-8")
        return self.config_path

    def test_loads_arbitrary_adapter_selection_without_runner_branches(self) -> None:
        loaded = load_fabric_config(
            self.write_config(
                {
                    "schema_version": "fabric.agent/v1alpha1",
                    "metadata": {"name": "example-agent"},
                    "harness": {
                        "adapter_id": "third.party.future-harness",
                        "resolution": "preinstalled",
                        "settings": {"adapter_owned": True},
                    },
                    "runtime": {"timeout_seconds": 30},
                }
            )
        )

        self.assertEqual(loaded.config.harness.adapter_id, "third.party.future-harness")
        self.assertEqual(loaded.config.harness.settings, {"adapter_owned": True})
        self.assertEqual(loaded.base_dir, self.base_dir.resolve())
        self.assertEqual(loaded.path, self.config_path.resolve())
        self.assertEqual(
            loaded.content_sha256,
            hashlib.sha256(self.config_path.read_bytes()).hexdigest(),
        )

    def test_rejects_a_symlinked_or_multiply_linked_config(self) -> None:
        target = self.base_dir / "target.json"
        target.write_text("{}", encoding="utf-8")

        self.config_path.symlink_to(target)
        with self.assertRaisesRegex(FabricConfigLoadError, "regular file"):
            load_fabric_config(self.config_path)

        self.config_path.unlink()
        os.link(target, self.config_path)
        with self.assertRaisesRegex(FabricConfigLoadError, "one regular file"):
            load_fabric_config(self.config_path)

    def test_rejects_an_oversized_config_before_parsing(self) -> None:
        self.config_path.write_bytes(b" " * (FABRIC_CONFIG_MAX_BYTES + 1))

        with (
            patch("nemoclaw_fabric.config.FabricConfig.from_mapping") as parse_config,
            self.assertRaisesRegex(FabricConfigLoadError, "exceeds"),
        ):
            load_fabric_config(self.config_path)

        parse_config.assert_not_called()

    def test_accepts_a_valid_config_at_the_size_limit(self) -> None:
        payload = json.dumps(
            {
                "metadata": {"name": "size-boundary"},
                "harness": {"adapter_id": "third.party.harness"},
                "runtime": {"timeout_seconds": 30},
            }
        ).encode("utf-8")
        self.config_path.write_bytes(
            payload + (b" " * (FABRIC_CONFIG_MAX_BYTES - len(payload)))
        )

        loaded = load_fabric_config(self.config_path)

        self.assertEqual(loaded.config.harness.adapter_id, "third.party.harness")
        self.assertEqual(self.config_path.stat().st_size, FABRIC_CONFIG_MAX_BYTES)

    def test_rejects_a_fifo_promptly(self) -> None:
        os.mkfifo(self.config_path)
        script = """
from nemoclaw_fabric.config import FabricConfigLoadError, load_fabric_config
import sys
try:
    load_fabric_config(sys.argv[1])
except FabricConfigLoadError:
    raise SystemExit(0)
raise SystemExit(1)
"""

        result = subprocess.run(
            [sys.executable, "-c", script, str(self.config_path)],
            check=False,
            capture_output=True,
            timeout=2,
        )

        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))

    def test_supervisor_identity_rejects_a_config_changed_before_worker_load(self) -> None:
        config_path = self.write_config(
            {
                "metadata": {"name": "supervised-agent"},
                "harness": {"adapter_id": "third.party.harness"},
                "runtime": {"timeout_seconds": 30},
            }
        )
        selected = load_fabric_config(config_path)
        config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "changed-agent"},
                    "harness": {"adapter_id": "third.party.changed"},
                    "runtime": {"timeout_seconds": 30},
                }
            ),
            encoding="utf-8",
        )
        reloaded = load_fabric_config(config_path)

        with self.assertRaisesRegex(
            FabricConfigLoadError,
            "changed after the request supervisor validated it",
        ):
            require_supervisor_config_identity(
                reloaded,
                {SUPERVISOR_CONFIG_SHA256_ENV: selected.content_sha256},
            )

    def test_supervisor_identity_rejects_malformed_expected_digests(self) -> None:
        loaded = load_fabric_config(
            self.write_config(
                {
                    "metadata": {"name": "supervised-agent"},
                    "harness": {"adapter_id": "third.party.harness"},
                    "runtime": {"timeout_seconds": 30},
                }
            )
        )

        for digest in ("", "A" * 64, "0" * 63, "g" * 64):
            with self.subTest(digest=digest), self.assertRaises(FabricConfigLoadError):
                require_supervisor_config_identity(
                    loaded,
                    {SUPERVISOR_CONFIG_SHA256_ENV: digest},
                )

    def test_accepts_credential_free_uri_and_email_values(self) -> None:
        values = (
            "https://example.invalid/v1",
            "postgresql://example.invalid/database",
            "https://example.invalid/v1?contact=alice@example.com",
            "https://example.invalid/v1/alice%40example.com",
            "https://example.invalid/v1?contact=alice%40example.com",
            "alice@example.com",
        )
        for value in values:
            with self.subTest(value=value):
                loaded = load_fabric_config(
                    self.write_config(
                        {
                            "metadata": {"name": "credential-free-uri"},
                            "harness": {
                                "adapter_id": "third.party.harness",
                                "settings": {"endpoint": value},
                            },
                            "runtime": {"timeout_seconds": 30},
                        }
                    )
                )

                self.assertEqual(loaded.config.harness.settings["endpoint"], value)

    def test_rejects_uri_authority_userinfo_before_native_config_parsing(self) -> None:
        credential_uris = (
            "https://alice@example.invalid/v1",
            "https://alice:ordinary-password@example.invalid/v1",
            "https://:ordinary-password@example.invalid/v1",
            "https://alice:%70assword@example.invalid/v1",
            "https://alice%40corp:pass@example.invalid/v1",
            "https://alice:pass%40example.invalid/v1",
            "HTTPS://alice:pass@example.invalid/v1",
            "postgresql://alice:pass@example.invalid/database",
            "//alice:pass@example.invalid/v1",
            "https://alice:pass@example.invalid:notaport/v1",
            "https://alice:pass@[example.invalid/v1",
        )
        for credential_uri in credential_uris:
            with self.subTest(credential_uri=credential_uri):
                with (
                    patch(
                        "nemoclaw_fabric.config.FabricConfig.from_mapping"
                    ) as from_mapping,
                    self.assertRaisesRegex(
                        FabricConfigLoadError,
                        r"harness\.settings\.endpoint must not contain URI authority userinfo",
                    ) as caught,
                ):
                    load_fabric_config(
                        self.write_config(
                            {
                                "metadata": {"name": "credential-bearing-uri"},
                                "harness": {
                                    "adapter_id": "third.party.harness",
                                    "settings": {"endpoint": credential_uri},
                                },
                                "runtime": {"timeout_seconds": 30},
                            }
                        )
                    )

                from_mapping.assert_not_called()
                self.assertNotIn(credential_uri, str(caught.exception))
                self.assertNotIn("ordinary-password", str(caught.exception))

    def test_accepts_workflow_selection_without_a_harness(self) -> None:
        loaded = load_fabric_config(
            self.write_config(
                {
                    "metadata": {"name": "workflow-agent"},
                    "workflow": {
                        "target_id": "third.party.workflow",
                        "settings": {"entrypoint": "example:workflow"},
                    },
                    "runtime": {"timeout_seconds": 30},
                }
            )
        )

        self.assertIsNone(loaded.config.harness)
        self.assertEqual(loaded.config.workflow.target_id, "third.party.workflow")

    def test_preserves_credential_name_indirection_without_resolving_it(self) -> None:
        loaded = load_fabric_config(
            self.write_config(
                {
                    "metadata": {"name": "model-agent"},
                    "harness": {"adapter_id": "third.party.harness"},
                    "runtime": {"timeout_seconds": 30},
                    "models": {
                        "default": {
                            "provider": "example",
                            "model": "example-model",
                            "api_key_env": "EXAMPLE_API_KEY",
                        }
                    },
                }
            )
        )

        self.assertEqual(
            loaded.config.models["default"].api_key_env,
            "EXAMPLE_API_KEY",
        )
        self.assertEqual(
            loaded.credential_environment_names,
            ("EXAMPLE_API_KEY",),
        )

    def test_reads_package_owned_invocation_unavailability_without_adapter_branches(
        self,
    ) -> None:
        reason = "The selected model needs an option that this released adapter cannot apply."
        loaded = load_fabric_config(
            self.write_config(
                {
                    "metadata": {"name": "unavailable-model-options"},
                    "harness": {"adapter_id": "third.party.harness"},
                    "runtime": {"timeout_seconds": 30},
                    "environment": {
                        "metadata": {
                            "nemoclaw": {
                                "invocation_unavailable_reason": reason,
                            }
                        }
                    },
                }
            )
        )

        self.assertEqual(loaded.invocation_unavailable_reason, reason)

    def test_rejects_invalid_package_owned_unavailability_reasons(self) -> None:
        for reason in ("", "   ", 42, ["not", "text"]):
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(
                    FabricConfigLoadError,
                    "invocation_unavailable_reason must be a non-empty string",
                ):
                    load_fabric_config(
                        self.write_config(
                            {
                                "metadata": {"name": "invalid-unavailable-reason"},
                                "harness": {"adapter_id": "third.party.harness"},
                                "runtime": {"timeout_seconds": 30},
                                "environment": {
                                    "metadata": {
                                        "nemoclaw": {
                                            "invocation_unavailable_reason": reason,
                                        }
                                    }
                                },
                            }
                        )
                    )

    def test_collects_every_pinned_fabric_credential_environment_reference(self) -> None:
        loaded = load_fabric_config(
            self.write_config(
                {
                    "metadata": {"name": "credential-fields"},
                    "harness": {"adapter_id": "third.party.harness"},
                    "runtime": {"timeout_seconds": 30},
                    "models": {
                        "default": {
                            "provider": "example",
                            "model": "example-model",
                            "api_key_env": "MODEL_API_KEY",
                        }
                    },
                    "mcp": {
                        "servers": {
                            "service": {
                                "transport": "streamable-http",
                                "url": "https://mcp.example",
                                "authentication": {
                                    "type": "service_account",
                                    "client_id": "example-client",
                                    "client_secret_env": "MCP_CLIENT_SECRET",
                                    "token_url": "https://auth.example/token",
                                    "token_endpoint_auth_method": "client_secret_post",
                                },
                            }
                        }
                    },
                    "relay": {
                        "observability": {
                            "version": 3,
                            "atof": {
                                "enabled": True,
                                "sinks": [
                                    {
                                        "type": "stream",
                                        "url": "https://atof.example",
                                        "header_env": {
                                            "Authorization": "ATOF_AUTHORIZATION"
                                        },
                                    }
                                ],
                            },
                            "atif": {
                                "enabled": True,
                                "storage": [
                                    {
                                        "type": "s3",
                                        "bucket": "example-bucket",
                                        "secret_access_key_var": "S3_SECRET_ACCESS_KEY",
                                        "session_token_var": "S3_SESSION_TOKEN",
                                    },
                                    {
                                        "type": "http",
                                        "endpoint": "https://atif.example",
                                        "header_env": {"X-API-Key": "ATIF_API_KEY"},
                                    },
                                ],
                            },
                            "opentelemetry": {
                                "enabled": True,
                                "endpoints": [
                                    {
                                        "type": "full",
                                        "endpoint": "https://otel.example",
                                        "header_env": {
                                            "Authorization": "OTEL_AUTHORIZATION"
                                        },
                                    }
                                ],
                            },
                        }
                    },
                }
            )
        )

        self.assertEqual(
            loaded.credential_environment_names,
            (
                "ATIF_API_KEY",
                "ATOF_AUTHORIZATION",
                "MCP_CLIENT_SECRET",
                "MODEL_API_KEY",
                "OTEL_AUTHORIZATION",
                "S3_SECRET_ACCESS_KEY",
                "S3_SESSION_TOKEN",
            ),
        )

    def test_collects_adapter_extension_and_explicit_credential_environment_names(self) -> None:
        loaded = load_fabric_config(
            self.write_config(
                {
                    "metadata": {"name": "extension-credentials"},
                    "harness": {
                        "adapter_id": "third.party.harness",
                        "settings": {"token_env": "INNOCUOUS_ENV_NAME"},
                    },
                    "runtime": {"timeout_seconds": 30},
                    "environment": {
                        "metadata": {
                            "nemoclaw": {
                                "credential_environment_names": [
                                    "ADAPTER_OWNED_CREDENTIAL"
                                ]
                            }
                        }
                    },
                }
            )
        )

        self.assertEqual(
            loaded.credential_environment_names,
            ("ADAPTER_OWNED_CREDENTIAL", "INNOCUOUS_ENV_NAME"),
        )

    def test_rejects_literal_credentials_in_fabric_environment_values(self) -> None:
        with self.assertRaisesRegex(
            FabricConfigLoadError,
            r"environment\.env\.PRIVATE_TOKEN must not contain a literal credential",
        ):
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "literal-environment-secret"},
                        "harness": {"adapter_id": "third.party.harness"},
                        "runtime": {"timeout_seconds": 30},
                        "environment": {
                            "env": {"PRIVATE_TOKEN": "literal-secret-value"}
                        },
                    }
                )
            )

    def test_rejects_literals_for_adapter_declared_credential_names(self) -> None:
        credential_name = "INNOCUOUS_ENV_NAME"
        credential_sources = (
            {
                "harness": {
                    "adapter_id": "third.party.harness",
                    "settings": {"token_env": credential_name},
                }
            },
            {
                "harness": {"adapter_id": "third.party.harness"},
                "environment": {
                    "metadata": {
                        "nemoclaw": {
                            "credential_environment_names": [credential_name]
                        }
                    }
                },
            },
        )
        for credential_source in credential_sources:
            with self.subTest(credential_source=credential_source):
                payload = {
                    "metadata": {"name": "literal-declared-credential"},
                    "runtime": {"timeout_seconds": 30},
                    **credential_source,
                }
                environment = dict(payload.get("environment", {}))
                environment["env"] = {credential_name: "literal-secret-value"}
                payload["environment"] = environment

                with self.assertRaisesRegex(
                    FabricConfigLoadError,
                    rf"environment\.env\.{credential_name} must not contain a literal credential",
                ) as caught:
                    load_fabric_config(self.write_config(payload))

                self.assertNotIn("literal-secret-value", str(caught.exception))

    def test_rejects_literal_credentials_in_adapter_extensions(self) -> None:
        with self.assertRaisesRegex(
            FabricConfigLoadError,
            r"harness\.settings\.api_key must use environment-variable-name indirection",
        ):
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "literal-extension-secret"},
                        "harness": {
                            "adapter_id": "third.party.harness",
                            "settings": {"api_key": "literal-secret-value"},
                        },
                        "runtime": {"timeout_seconds": 30},
                    }
                )
            )

    def test_rejects_camel_case_credential_fields_in_adapter_extensions(self) -> None:
        credential_fields = ("clientSecret", "accessToken", "privateKey")
        for credential_field in credential_fields:
            with self.subTest(credential_field=credential_field):
                with self.assertRaisesRegex(
                    FabricConfigLoadError,
                    rf"harness\.settings\.{credential_field} must use "
                    r"environment-variable-name indirection",
                ) as caught:
                    load_fabric_config(
                        self.write_config(
                            {
                                "metadata": {"name": "camel-case-extension-secret"},
                                "harness": {
                                    "adapter_id": "third.party.harness",
                                    "settings": {
                                        credential_field: "ordinary-literal-value"
                                    },
                                },
                                "runtime": {"timeout_seconds": 30},
                            }
                        )
                    )

                self.assertNotIn("ordinary-literal-value", str(caught.exception))

    def test_collects_camel_case_credential_environment_references(self) -> None:
        loaded = load_fabric_config(
            self.write_config(
                {
                    "metadata": {"name": "camel-case-extension-reference"},
                    "harness": {
                        "adapter_id": "third.party.harness",
                        "settings": {"clientSecretEnv": "ADAPTER_CLIENT_SECRET"},
                    },
                    "runtime": {"timeout_seconds": 30},
                }
            )
        )

        self.assertEqual(
            loaded.credential_environment_names,
            ("ADAPTER_CLIENT_SECRET",),
        )

    def test_rejects_credential_shaped_values_under_neutral_adapter_fields(self) -> None:
        credential_values = (
            "sk-1234567890abcdefghij",
            "AKIA1234567890ABCDEF",
            "bot12345678:" + "a" * 35,
            "A" * 24 + "." + "B" * 6 + "." + "C" * 27,
            "eyJabcde.ab.abcdefghij",
            "lsv2_sk_1234567890",
            "KEY=ordinary-secret-value",
            "-----BEGIN "
            "PRIVATE KEY-----\nprivate-material\n-----END "
            "PRIVATE KEY-----",
        )
        for credential_value in credential_values:
            with self.subTest(credential_value=credential_value[:16]):
                with self.assertRaisesRegex(
                    FabricConfigLoadError,
                    r"harness\.settings\.description must not contain a literal credential",
                ) as caught:
                    load_fabric_config(
                        self.write_config(
                            {
                                "metadata": {"name": "neutral-extension-secret"},
                                "harness": {
                                    "adapter_id": "third.party.harness",
                                    "settings": {"description": credential_value},
                                },
                                "runtime": {"timeout_seconds": 30},
                            }
                        )
                    )

                self.assertNotIn(credential_value, str(caught.exception))

    def test_rejects_every_value_shape_under_sensitive_adapter_fields(self) -> None:
        sensitive_field_names = (
            "auth",
            "authorization",
            "credentials",
            "keys",
            "passphrases",
            "passwords",
            "secrets",
            "tokens",
        )
        credential_values = (
            ["Bearer sk-proj-list-secret"],
            {"value": "Bearer sk-proj-object-secret"},
            123456789,
            True,
            None,
        )
        for field_name in sensitive_field_names:
            for credential_value in credential_values:
                with self.subTest(
                    field_name=field_name,
                    credential_value=credential_value,
                ):
                    expected_path = rf"harness\.settings\.{field_name} must use "
                    with self.assertRaisesRegex(
                        FabricConfigLoadError,
                        expected_path + r"environment-variable-name indirection",
                    ) as caught:
                        load_fabric_config(
                            self.write_config(
                                {
                                    "metadata": {
                                        "name": "literal-extension-secret-shape"
                                    },
                                    "harness": {
                                        "adapter_id": "third.party.harness",
                                        "settings": {field_name: credential_value},
                                    },
                                    "runtime": {"timeout_seconds": 30},
                                }
                            )
                        )

                    self.assertNotIn(str(credential_value), str(caught.exception))

    def test_rejects_malformed_explicit_credential_environment_names(self) -> None:
        with self.assertRaisesRegex(
            FabricConfigLoadError,
            "entries must use letters, digits, and underscores",
        ):
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "malformed-credential-name"},
                        "harness": {"adapter_id": "third.party.harness"},
                        "runtime": {"timeout_seconds": 30},
                        "environment": {
                            "metadata": {
                                "nemoclaw": {
                                    "credential_environment_names": ["NOT-A-NAME"]
                                }
                            }
                        },
                    }
                )
            )

    def test_rejects_non_array_explicit_credential_environment_names(self) -> None:
        with self.assertRaisesRegex(
            FabricConfigLoadError,
            "credential_environment_names must be an array",
        ):
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "non-array-credential-names"},
                        "harness": {"adapter_id": "third.party.harness"},
                        "runtime": {"timeout_seconds": 30},
                        "environment": {
                            "metadata": {
                                "nemoclaw": {
                                    "credential_environment_names": "ADAPTER_CRED"
                                }
                            }
                        },
                    }
                )
            )

    def test_rejects_malformed_adapter_extension_credential_references(self) -> None:
        with self.assertRaisesRegex(
            FabricConfigLoadError,
            r"harness\.settings\.token_env must name an environment variable",
        ):
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "malformed-extension-credential"},
                        "harness": {
                            "adapter_id": "third.party.harness",
                            "settings": {"token_env": "NOT-A-NAME"},
                        },
                        "runtime": {"timeout_seconds": 30},
                    }
                )
            )

    def test_rejects_duplicate_explicit_credential_environment_names(self) -> None:
        with self.assertRaisesRegex(FabricConfigLoadError, "must not contain duplicates"):
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "duplicate-credential-name"},
                        "harness": {"adapter_id": "third.party.harness"},
                        "runtime": {"timeout_seconds": 30},
                        "environment": {
                            "metadata": {
                                "nemoclaw": {
                                    "credential_environment_names": [
                                        "ADAPTER_CRED",
                                        "ADAPTER_CRED",
                                    ]
                                }
                            }
                        },
                    }
                )
            )

    def test_rejects_non_object_json(self) -> None:
        with self.assertRaisesRegex(FabricConfigLoadError, "must contain a JSON object"):
            load_fabric_config(self.write_config(["not", "an", "object"]))

    def test_rejects_missing_agent_selector(self) -> None:
        with self.assertRaisesRegex(FabricConfigLoadError, "at least one of harness"):
            load_fabric_config(self.write_config({"metadata": {"name": "missing"}}))

    def test_requires_a_finite_runtime_timeout(self) -> None:
        with self.assertRaisesRegex(FabricConfigLoadError, "must set runtime.timeout_seconds"):
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "unbounded"},
                        "harness": {"adapter_id": "third.party.harness"},
                    }
                )
            )

    def test_rejects_non_positive_or_non_finite_runtime_timeouts(self) -> None:
        invalid_timeouts = {
            "zero": 0,
            "negative": -1,
            "not-a-number": float("nan"),
            "infinity": float("inf"),
        }
        for case, timeout_seconds in invalid_timeouts.items():
            with self.subTest(case=case):
                with self.assertRaisesRegex(
                    FabricConfigLoadError,
                    r"runtime\.timeout_seconds",
                ):
                    load_fabric_config(
                        self.write_config(
                            {
                                "metadata": {"name": "invalid-timeout"},
                                "harness": {"adapter_id": "third.party.harness"},
                                "runtime": {"timeout_seconds": timeout_seconds},
                            }
                        )
                    )

    def test_rejects_malformed_json_with_location(self) -> None:
        self.config_path.write_text('{"metadata":', encoding="utf-8")

        with self.assertRaisesRegex(FabricConfigLoadError, r"line 1, column"):
            load_fabric_config(self.config_path)

    def test_validation_error_does_not_echo_rejected_values(self) -> None:
        secret = "should-never-appear-in-diagnostics"

        with self.assertRaises(FabricConfigLoadError) as caught:
            load_fabric_config(
                self.write_config(
                    {
                        "metadata": {"name": "invalid"},
                        "harness": {"adapter_id": "valid"},
                        "runtime": {"timeout_seconds": secret},
                    }
                )
            )

        self.assertNotIn(secret, str(caught.exception))
        self.assertIn("runtime.timeout_seconds", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
