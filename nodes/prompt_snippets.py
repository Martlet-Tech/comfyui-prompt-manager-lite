"""
Prompt Snippets - a global snippet list node for ComfyUI.

Stores short reusable text fragments in a dedicated file
(<user>/default/prompt_snippets.json), deliberately separate from the
prompt-manager library so snippet data never mixes with the thumbnail-
capable prompt records. All snippet nodes share this one library.
"""

import json
import os
import time

from aiohttp import web
from server import PromptServer

from .prompt_manager_lite import atomic_save

import folder_paths

SNIPPETS_FILE_NAME = "prompt_snippets.json"


def get_snippets_path():
    return os.path.join(folder_paths.get_user_directory(), "default", SNIPPETS_FILE_NAME)


def load_snippets():
    path = get_snippets_path()
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[PromptSnippets] Error loading {path}: {e}")
        return []
    if isinstance(data, dict) and isinstance(data.get("snippets"), list):
        return data["snippets"]
    if isinstance(data, list):
        return data
    return []


def save_snippets(snippets):
    if not isinstance(snippets, list):
        return False
    return atomic_save(get_snippets_path(), {"snippets": snippets}, "PromptSnippets")


class PromptSnippets:
    """Note-like node holding a searchable list of reusable text snippets."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "output_text": ("STRING", {"default": ""}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    CATEGORY = "Prompt Manager Lite"
    DESCRIPTION = "Note-like node with a searchable snippet list. Click a snippet to copy it and send it to the prompts output."
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompts",)
    FUNCTION = "get_prompts"

    @classmethod
    def IS_CHANGED(cls, output_text="", **kwargs):
        return (output_text,)

    def get_prompts(self, output_text="", **kwargs):
        return (output_text if output_text else "",)


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/prompt-snippets/get-snippets")
async def snippets_get(request):
    try:
        return web.json_response({"success": True, "snippets": load_snippets()})
    except Exception as e:
        print(f"[PromptSnippets] Error in get_snippets API: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/prompt-snippets/save-snippets")
async def snippets_save(request):
    try:
        data = await request.json()
        snippets = data.get("snippets")
        if not isinstance(snippets, list):
            return web.json_response({"success": False, "error": "Invalid snippets"}, status=400)

        # Keep records lean and stable: id, text, tag, created_at.
        cleaned = []
        seen_ids = set()
        for s in snippets:
            if not isinstance(s, dict):
                continue
            text = str(s.get("text", "")).strip()
            if not text:
                continue
            sid = str(s.get("id", "")).strip() or f"s{int(time.time() * 1000)}"
            while sid in seen_ids:
                sid += "x"
            seen_ids.add(sid)
            cleaned.append({
                "id": sid,
                "text": text,
                "tag": str(s.get("tag", "")).strip(),
                "created_at": str(s.get("created_at", "") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
            })

        if not save_snippets(cleaned):
            return web.json_response({"success": False, "error": "Failed to save snippets"}, status=500)
        return web.json_response({"success": True, "snippets": cleaned})
    except Exception as e:
        print(f"[PromptSnippets] Error in save_snippets API: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)
