# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""NemoClaw runtime integration for Hermes Agent.

The register(ctx) entry point installs managed tool and messaging behavior,
then registers NemoClaw tools and lifecycle hooks with Hermes. Managed tool
compatibility lives in tool_broker.py. Channel-specific runtime adapters live
in sibling modules and load only when their channel is configured.

Hermes caches its skill command registry after the first scan. The
nemoclaw_reload_skills tool clears that cache so new skills become available
without a gateway restart. The session-start hook performs the same refresh.

The pre_llm_call hook gives the model sandbox context without adding a visible
message to the Hermes transcript.
"""

import importlib.util
import inspect
import json
import logging
import os
import re
import subprocess
import sys


def _load_tool_broker_module():
    """Load the sibling broker module in package and standalone test modes."""
    if __package__ and __package__ in sys.modules:
        from . import tool_broker

        return tool_broker

    module_path = os.path.join(os.path.dirname(__file__), "tool_broker.py")
    spec = importlib.util.spec_from_file_location(f"{__name__}_tool_broker", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load Hermes tool broker from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_tool_broker = _load_tool_broker_module()
_TOOL_GATEWAY_URL_ENV = _tool_broker._TOOL_GATEWAY_URL_ENV
_get_env_value = _tool_broker._get_env_value
_broker_mode_enabled = _tool_broker._broker_mode_enabled
_install_nous_tool_broker_patch = _tool_broker._install_nous_tool_broker_patch
_load_hermes_config = _tool_broker._load_hermes_config

_MESSAGING_RESPONSE_PATCH_ATTR = "_nemoclaw_messaging_response_patch_installed"
_NEMOCLAW_CONTEXT_KEYWORDS = (
    "browser",
    "config",
    "discord",
    "environment",
    "gateway",
    "hermes",
    "host",
    "logs",
    "modal",
    "nemoclaw",
    "openshell",
    "sandbox",
    "skill",
    "slack",
    "status",
    "telegram",
    "tool",
    "where am i",
    "whoami",
)

_MESSAGING_PLATFORMS = (
    "telegram",
    "discord",
    "slack",
    "whatsapp",
    "signal",
    "sms",
    "email",
    "matrix",
    "mattermost",
    "dingtalk",
    "feishu",
    "wecom",
    "wecom_callback",
    "weixin",
    "qqbot",
    "yuanbao",
    "webhook",
    "google_chat",
)
_RAW_MESSAGING_TOOL_RE = re.compile(
    r"^\s*send_message\s*:\s*(?P<body>.+?)\s*$",
    flags=re.IGNORECASE | re.DOTALL,
)
_RAW_MESSAGING_TARGET_RE = re.compile(
    r"^(?:to\s+)?(?P<platform>"
    + "|".join(re.escape(platform) for platform in _MESSAGING_PLATFORMS)
    + r")\s*:\s*(?P<message>.+)$",
    flags=re.IGNORECASE | re.DOTALL,
)


def _load_nemoclaw_config():
    """Load NemoClaw onboard config from ~/.nemoclaw/config.json."""
    config_path = os.path.expanduser("~/.nemoclaw/config.json")
    if not os.path.exists(config_path):
        return None
    try:
        with open(config_path) as f:
            return json.load(f)
    except Exception:
        return None


def _hermes_api_port():
    """Read the per-sandbox port the OpenAI-compatible API is exposed on.

    NemoClaw allocates this port per sandbox so two Hermes sandboxes can serve
    inference on one host. The plugin normally inherits the allocated value
    from the managed supervisor. The root-separated topology also publishes a
    root-owned marker for processes that do not inherit that environment.
    """
    raw = os.environ.get("NEMOCLAW_HERMES_API_PORT", "").strip()
    if not raw:
        try:
            with open("/run/nemoclaw/hermes-api-port") as f:
                raw = f.read().strip()
        except OSError:
            return 8642
    if re.fullmatch(r"[0-9]+", raw) is None:
        return 8642
    try:
        port = int(raw)
    except ValueError:
        return 8642
    return port if 8642 <= port <= 8652 else 8642


def _get_sandbox_info():
    """Gather sandbox status information."""
    hermes_cfg = _load_hermes_config()
    nemoclaw_cfg = _load_nemoclaw_config()

    model = "unknown"
    provider = "custom"
    base_url = "unknown"

    if hermes_cfg:
        model_cfg = hermes_cfg.get("model", {})
        model = model_cfg.get("default", "unknown")
        provider = model_cfg.get("provider", "custom")
        base_url = model_cfg.get("base_url", "unknown")

    if nemoclaw_cfg:
        model = nemoclaw_cfg.get("model", model)
        provider = nemoclaw_cfg.get("provider", provider)

    # Check gateway health
    api_port = _hermes_api_port()
    gateway_ok = False
    try:
        result = subprocess.run(
            ["curl", "-sf", f"http://localhost:{api_port}/health"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            gateway_ok = True
    except Exception:
        # Status output should still render if the local health probe fails.
        pass

    return {
        "agent": "hermes",
        "model": model,
        "provider": provider,
        "base_url": base_url,
        "gateway": "running" if gateway_ok else "stopped",
        "port": api_port,
    }


def _active_managed_gateway_services():
    """List managed Nous services that have broker URLs configured."""
    services = []
    for service, env_key in _TOOL_GATEWAY_URL_ENV.items():
        if _get_env_value(env_key, ""):
            services.append(service)
    return services


def _strip_wrapping_quotes(text):
    value = str(text or "").strip()
    while len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1].strip()
    return value


# Tracks the messaging platform of the active LLM call so the normalizer
# below can refuse to silently rewrite cross-platform send_message pseudo-calls
# into the wrong chat (PR #4175 review feedback from @cv). Updated on every
# `_pre_llm_call` and read by the patched `_strip_think_blocks`.
_current_messaging_platform = {"value": None}


def _set_current_messaging_platform(platform):
    raw = str(platform or "").strip().lower()
    _current_messaging_platform["value"] = raw if raw in _MESSAGING_PLATFORMS else None


def _get_current_messaging_platform():
    return _current_messaging_platform["value"]


def _normalize_raw_messaging_tool_response(response, current_platform=None):
    """Convert a raw send_message pseudo-call into the message body.

    Defense-in-depth fallback for the first-turn race in #3893 where the
    Hermes tool-dispatch isn't ready when the messaging adapter delivers the
    first user turn, so the model emits text like
    ``send_message: "to telegram: Hello"`` as the final answer instead of
    using the structured tool-calling channel. Returning the body is the
    correct delivery path **only when the target platform matches the current
    chat platform** — otherwise (per the #4175 review) a stray
    ``send_message: "to slack: ..."`` from a Telegram chat would be silently
    delivered back to Telegram, misrouting a cross-platform send_message
    intent.

    Source of truth for send_message routing is Hermes' upstream tool
    dispatcher; this normalizer is purely an output filter on
    `AIAgent._strip_think_blocks`. End-to-end
    coverage runs via ``hermes-e2e``, ``hermes-discord-e2e``, and
    ``hermes-slack-e2e`` against a real gateway first-message path.
    """
    if not isinstance(response, str):
        return response
    match = _RAW_MESSAGING_TOOL_RE.match(response)
    if not match:
        return response

    body = _strip_wrapping_quotes(match.group("body"))
    target_match = _RAW_MESSAGING_TARGET_RE.match(body)
    if not target_match:
        return response

    target_platform = (target_match.group("platform") or "").strip().lower()
    current = (str(current_platform or "").strip().lower()) or None
    if current is None or target_platform != current:
        # Cross-platform or unknown-platform pseudo-call — leave it intact so
        # it surfaces as a dispatch/error path rather than getting silently
        # delivered into the wrong chat.
        return response

    message = _strip_wrapping_quotes(target_match.group("message"))
    return message if message else response


def _install_messaging_response_patch():
    """Prevent raw messaging pseudo-tool calls from leaking as final text."""
    try:
        module = __import__("run_agent", fromlist=["AIAgent"])
    except (ImportError, ModuleNotFoundError):
        return False

    agent_cls = getattr(module, "AIAgent", None)
    if agent_cls is None or getattr(agent_cls, _MESSAGING_RESPONSE_PATCH_ATTR, False):
        return False

    raw_original = inspect.getattr_static(agent_cls, "_strip_think_blocks", None)
    original = getattr(agent_cls, "_strip_think_blocks", None)
    if not callable(original):
        return False

    if isinstance(raw_original, staticmethod):
        original_func = raw_original.__func__

        def _strip_think_blocks(content):
            return _normalize_raw_messaging_tool_response(
                original_func(content),
                current_platform=_get_current_messaging_platform(),
            )

        agent_cls._strip_think_blocks = staticmethod(_strip_think_blocks)
    elif isinstance(raw_original, classmethod):
        original_func = raw_original.__func__

        def _strip_think_blocks(cls, content):
            return _normalize_raw_messaging_tool_response(
                original_func(cls, content),
                current_platform=_get_current_messaging_platform(),
            )

        agent_cls._strip_think_blocks = classmethod(_strip_think_blocks)
    else:
        def _strip_think_blocks(self, content):
            return _normalize_raw_messaging_tool_response(
                original(self, content),
                current_platform=_get_current_messaging_platform(),
            )

        agent_cls._strip_think_blocks = _strip_think_blocks

    setattr(agent_cls, _MESSAGING_RESPONSE_PATCH_ATTR, True)
    return True


def _should_inject_nemoclaw_context(user_message=None, is_first_turn=False):
    """Return whether this turn needs NemoClaw runtime grounding."""
    if is_first_turn:
        return True
    text = str(user_message or "").lower()
    return any(keyword in text for keyword in _NEMOCLAW_CONTEXT_KEYWORDS)


def _build_nemoclaw_agent_context(platform=None):
    """Build quiet, ephemeral context for Hermes' pre_llm_call hook."""
    info = _get_sandbox_info()
    hermes_home = (
        os.getenv("HERMES_HOME")
        or _get_env_value("HERMES_HOME", "")
        or "/sandbox/.hermes"
    )
    services = _active_managed_gateway_services()
    service_text = ", ".join(services) if services else "none detected"
    broker_state = "enabled" if _broker_mode_enabled() else "not enabled"
    platform_text = str(platform or "").strip()
    platform_line = (
        f"- Current Hermes messaging platform: {platform_text}. Messaging adapters "
        + "run in the parent Hermes gateway sandbox; child tool-execution containers "
        + "will not show their host/gateway config."
        if platform_text
        else "- Messaging adapters run in the parent Hermes gateway sandbox; child "
        + "tool-execution containers will not show their host/gateway config."
    )
    reply_line = None
    if platform_text.lower() in _MESSAGING_PLATFORMS:
        reply_line = (
            f"- Reply to the current {platform_text} chat by returning normal assistant text. "
            + "Use send_message only when the user explicitly asks you to send a separate "
            + "cross-platform message; never write raw text such as `send_message: ...` "
            + "or `to telegram: ...` as the final answer."
        )
    agent_identity_line = (
        "- You are Hermes Agent running in a NemoClaw-managed OpenShell sandbox, "
        + "not a host-only assistant."
    )
    child_tool_line = (
        "- Some tools, especially managed code/terminal tools, execute in child "
        + "tool sandboxes such as Modal. Seeing /__modal, MODAL_SANDBOX_ID, a "
        + "missing hermes binary, or missing ~/.hermes inside a tool shell "
        + "means that shell is a child tool sandbox, not proof that Hermes is "
        + "running on the host."
    )
    config_line = (
        f"- Parent Hermes sandbox config lives under {hermes_home} and "
        + "/sandbox/.hermes when available. Use nemoclaw_status or "
        + "nemoclaw_info for NemoClaw environment questions."
    )
    tools_line = (
        "- NemoClaw tools available: nemoclaw_status, nemoclaw_info, "
        + "nemoclaw_reload_skills, transcribe_audio."
    )

    lines = [
        "NemoClaw runtime context:",
        agent_identity_line,
        child_tool_line,
        config_line,
        f"- NemoClaw provider state: model={info['model']}, "
        f"provider={info['provider']}, endpoint={info['base_url']}, "
        f"gateway={info['gateway']}.",
        tools_line,
        f"- Managed Nous tool broker: {broker_state}; configured services: "
        f"{service_text}. Raw Nous OAuth tokens are host-managed by NemoClaw "
        "and should not be expected inside the sandbox.",
        platform_line,
    ]
    if reply_line:
        lines.append(reply_line)
    return "\n".join(lines)


def _pre_llm_call(**kwargs):
    """Inject non-visible NemoClaw runtime context into relevant Hermes turns."""
    # Track platform on every turn (not gated on context injection) so the
    # `_strip_think_blocks` normalizer (#4175) has a current-platform anchor
    # even on non-first turns and non-grounding turns.
    _set_current_messaging_platform(kwargs.get("platform"))
    if not _should_inject_nemoclaw_context(
        user_message=kwargs.get("user_message"),
        is_first_turn=bool(kwargs.get("is_first_turn")),
    ):
        return None
    _install_nous_tool_broker_patch()
    _install_messaging_response_patch()
    return {"context": _build_nemoclaw_agent_context(platform=kwargs.get("platform"))}


def _handle_status(tool_input=None, context=None, **_kwargs):
    """Handle the nemoclaw_status tool call."""
    info = _get_sandbox_info()
    lines = [
        "NemoClaw Sandbox Status (Hermes)",
        "\u2500" * 40,
        f"  Agent:    Hermes Agent",
        f"  Gateway:  {info['gateway']}",
        f"  Model:    {info['model']}",
        f"  Provider: {info['provider']}",
        f"  Endpoint: {info['base_url']}",
        f"  API:      http://localhost:{info['port']}/v1",
    ]
    return "\n".join(lines)


def _handle_info(tool_input=None, context=None, **_kwargs):
    """Handle the nemoclaw_info tool call — returns structured JSON."""
    return json.dumps(_get_sandbox_info(), indent=2)


def _handle_transcribe_audio(tool_input=None, context=None, **_kwargs):
    """Transcribe an audio file from the parent Hermes sandbox."""
    _install_nous_tool_broker_patch()
    args = tool_input if isinstance(tool_input, dict) else {}
    file_path = str(args.get("file_path") or "").strip()
    model = args.get("model")

    if not file_path:
        return json.dumps(
            {
                "success": False,
                "transcript": "",
                "error": "file_path is required",
            },
        )

    try:
        from tools.transcription_tools import transcribe_audio

        result = transcribe_audio(file_path, model=str(model).strip() if model else None)
    except Exception as exc:
        result = {
            "success": False,
            "transcript": "",
            "error": f"Transcription failed: {exc}",
        }

    return json.dumps(result, indent=2, ensure_ascii=False)


def _reload_skills():
    """Clear the Hermes skill slash-command cache and re-scan skill directories.

    Hermes's ``agent.skill_commands`` module caches discovered skills in a
    module-global dict (``_skill_commands``).  ``get_skill_commands()`` only
    scans on first call, so skills installed after gateway startup are
    invisible.  We clear the dict and call ``scan_skill_commands()`` to force
    a fresh scan.

    Returns the dict of discovered skills, or None on failure.
    """
    try:
        import agent.skill_commands as sc

        sc._skill_commands.clear()
        return sc.scan_skill_commands()
    except ImportError:
        return None
    except Exception:
        return None


def _handle_reload_skills(tool_input=None, context=None, **_kwargs):
    """Handle the nemoclaw_reload_skills tool call."""
    commands = _reload_skills()
    if commands is None:
        return (
            "Failed to reload skills. The agent.skill_commands module may "
            "not be available in this Hermes version."
        )

    if not commands:
        return "Skill reload complete. No skills found in skill directories."

    names = sorted(commands.keys())
    lines = [f"Skill reload complete. {len(names)} skill(s) discovered:", ""]
    for name in names:
        info = commands[name]
        desc = info.get("description", "no description")
        lines.append(f"  {name}: {desc}")
    return "\n".join(lines)


# Google Chat: the Hermes package owns the override at
# messaging/runtime/googlechat/hermes-adapter.py. The image copies it in beside
# this file. Loaded only when the channel is configured, so other sandboxes
# never replace the bundled platform entry.
_GOOGLE_CHAT_SUBSCRIPTION_ENV = "GOOGLE_CHAT_SUBSCRIPTION_NAME"
_GOOGLE_CHAT_MODULE = "googlechat_adapter.py"


def _install_googlechat_adapter(ctx):
    """Install the Google Chat override when that channel is configured.

    The module is loaded by path: Hermes imports this plugin as a directory
    module under a synthetic name, so a relative import has no package context.
    Load failure must not abort plugin registration, but it has to be visible —
    without the override the bundled gRPC adapter hangs under the REST-only
    egress policy and the channel goes quiet with no other clue.
    """
    if not _get_env_value(_GOOGLE_CHAT_SUBSCRIPTION_ENV):
        return False
    path = os.path.join(os.path.dirname(__file__), _GOOGLE_CHAT_MODULE)
    try:
        spec = importlib.util.spec_from_file_location("nemoclaw_hermes_googlechat", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.install(ctx)
    except Exception:
        logging.getLogger("gateway.platforms.google_chat").exception(
            "[GoogleChat][NemoClaw] loading %s failed", _GOOGLE_CHAT_MODULE,
        )
        return False
    return True


def register(ctx):
    """Register NemoClaw tools and hooks with Hermes."""
    _install_nous_tool_broker_patch()
    # Hermes 0.20.6 discovers plugins on a background thread while run_agent
    # imports model_tools and waits for discovery to finish. Importing
    # run_agent from this registration path deadlocks those two threads. The
    # pre_llm_call hook below installs the patch before response processing.
    _install_googlechat_adapter(ctx)

    # Register status tool
    ctx.register_tool(
        name="nemoclaw_status",
        toolset="nemoclaw",
        # Pass the bare function object; Hermes wraps it in the
        # {"type":"function","function":{...}} envelope at request-build time.
        # Pre-wrapping here double-wraps the tool, which strict providers
        # (Gemini) reject with HTTP 400 (#7067).
        schema={
            "name": "nemoclaw_status",
            "description": (
                "Show NemoClaw sandbox status: agent type, gateway health, "
                "model, provider, and inference endpoint."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
        handler=_handle_status,
        description="NemoClaw sandbox status",
    )

    # Register info tool (structured JSON output)
    ctx.register_tool(
        name="nemoclaw_info",
        toolset="nemoclaw",
        schema={
            "name": "nemoclaw_info",
            "description": "Get NemoClaw sandbox info as structured JSON.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=_handle_info,
        description="NemoClaw sandbox info (JSON)",
    )

    ctx.register_tool(
        name="transcribe_audio",
        toolset="audio",
        schema={
            "name": "transcribe_audio",
            "description": (
                "Transcribe an audio file that already exists in the Hermes "
                "sandbox. In NemoClaw broker mode this uses the managed "
                "OpenAI-audio gateway instead of direct OpenAI credentials."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to an audio file inside the Hermes sandbox.",
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional transcription model override.",
                    },
                },
                "required": ["file_path"],
            },
        },
        handler=_handle_transcribe_audio,
        description="Transcribe audio through the configured Hermes STT backend",
    )

    # Register skill reload tool
    ctx.register_tool(
        name="nemoclaw_reload_skills",
        toolset="nemoclaw",
        schema={
            "name": "nemoclaw_reload_skills",
            "description": (
                "Reload and re-discover skills from the skill directories. "
                "Call this after new skills have been installed to make them "
                "available as slash commands without restarting the gateway."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
        handler=_handle_reload_skills,
        description="Reload skills from disk without gateway restart",
    )

    # Ground the model quietly through Hermes' context hook. This replaces the
    # old visible startup banner without reintroducing TUI interrupt noise.
    ctx.register_hook("pre_llm_call", _pre_llm_call)

    # Refresh skills silently on session start. Earlier versions injected a
    # system banner here, but that can interrupt the user's first prompt in the
    # Hermes TUI because plugin-injected messages travel through Hermes's
    # interrupt queue. Keep startup native and expose status through tools.
    def _on_session_start(**kwargs):
        _install_nous_tool_broker_patch()
        _install_messaging_response_patch()
        _reload_skills()

    ctx.register_hook("on_session_start", _on_session_start)
