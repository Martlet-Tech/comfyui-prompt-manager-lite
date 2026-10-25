"""
Prompt Manager Lite - a minimal prompt library node for ComfyUI.

Keeps a single node (prompt selector + multiline text + STRING output) and the
prompt-library HTTP API needed by the thumbnail browser. Reads and writes the
same library file as the original Prompt Manager plugin:
    <user>/default/prompt_manager_data.json
"""

import json
import os
import shutil
import time
from datetime import datetime

import folder_paths
from aiohttp import web
from server import PromptServer

MAX_BACKUPS = 5
BACKUPS_DIR_NAME = "prompt_backups"
DATA_FILE_NAME = "prompt_manager_data.json"

# Keys written by this plugin; anything else already stored on a prompt record
# (e.g. loras_*, trigger_words, workflow_data written by the original plugin)
# is preserved verbatim on save.
_MANAGED_KEYS = {"prompt", "thumbnail", "nsfw", "saved_at"}


def _is_hidden_category_entry_key(key):
    normalized = str(key or "").lower()
    return normalized in ("__meta__", "_base_prompt_", "_prompt_prefix_")


# ---------------------------------------------------------------------------
# Storage helpers (self-contained subset of the original backup_manager.py)
# ---------------------------------------------------------------------------

def get_data_path():
    return os.path.join(folder_paths.get_user_directory(), "default", DATA_FILE_NAME)


def _backups_dir():
    return os.path.join(folder_paths.get_user_directory(), "default", BACKUPS_DIR_NAME)


def _backup_path(data_path, index):
    filename = os.path.basename(data_path)
    return os.path.join(_backups_dir(), f"{filename}_bak_{index:02d}")


def _rotate_backups(data_path):
    for i in range(MAX_BACKUPS, 1, -1):
        older = _backup_path(data_path, i)
        newer = _backup_path(data_path, i - 1)
        if os.path.exists(older):
            try:
                os.remove(older)
            except Exception:
                pass
        if os.path.exists(newer):
            try:
                shutil.copy2(newer, older)
            except Exception:
                pass


def _is_valid_json_file(path):
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            return isinstance(json.load(f), dict)
    except Exception:
        return False


def check_backup(data_path):
    """Daily rotating backup, called on startup."""
    if not _is_valid_json_file(data_path):
        return
    try:
        mtime = os.path.getmtime(data_path)
    except Exception:
        return
    backup1 = _backup_path(data_path, 1)
    try:
        if os.path.exists(backup1) and time.strftime(
            "%Y-%m-%d", time.localtime(os.path.getmtime(backup1))
        ) == time.strftime("%Y-%m-%d", time.localtime(mtime)):
            return
        os.makedirs(_backups_dir(), exist_ok=True)
        _rotate_backups(data_path)
        shutil.copy2(data_path, backup1)
        os.utime(backup1, None)
    except Exception as e:
        print(f"[PromptManagerLite] Backup skipped: {e}")


def atomic_save(data_path, data, log_prefix="PromptManagerLite"):
    if not isinstance(data, dict):
        print(f"[{log_prefix}] Refusing to save non-dict data to {data_path}")
        return False
    tmp_path = data_path + ".tmp"
    try:
        os.makedirs(os.path.dirname(data_path), exist_ok=True)
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, data_path)
        return True
    except Exception as e:
        print(f"[{log_prefix}] Error saving {data_path}: {e}")
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return False


def load_with_fallback(data_path, log_prefix="PromptManagerLite"):
    if _is_valid_json_file(data_path):
        try:
            with open(data_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[{log_prefix}] Error loading {data_path}: {e}")
    for i in range(1, MAX_BACKUPS + 1):
        candidate = _backup_path(data_path, i)
        if not _is_valid_json_file(candidate):
            continue
        try:
            with open(candidate, "r", encoding="utf-8") as f:
                data = json.load(f)
            print(f"[{log_prefix}] Recovered data from backup: {candidate}")
            return data
        except Exception:
            pass
    print(f"[{log_prefix}] No valid data/backup found for {data_path}.")
    return None


def sort_prompts_data(data):
    """Sort categories and prompts alphabetically (case-insensitive), keeping __meta__ last."""
    sorted_data = {}
    for category in sorted(data.keys(), key=str.lower):
        cat_data = data[category]
        if not isinstance(cat_data, dict):
            sorted_data[category] = cat_data
            continue
        meta = cat_data.get("__meta__")
        sorted_prompts = dict(sorted(
            ((k, v) for k, v in cat_data.items() if k != "__meta__"),
            key=lambda item: item[0].lower()
        ))
        if meta is not None:
            sorted_prompts["__meta__"] = meta
        sorted_data[category] = sorted_prompts
    return sorted_data


def load_prompts():
    return load_with_fallback(get_data_path()) or {}


def save_prompts(data):
    atomic_save(get_data_path(), sort_prompts_data(data))


def check_backup_on_startup():
    try:
        check_backup(get_data_path())
    except Exception as e:
        print(f"[PromptManagerLite] Backup initialization skipped: {e}")


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

class PromptManagerLite:
    """Minimal prompt manager: pick a prompt from the library, edit, output."""

    @classmethod
    def INPUT_TYPES(s):
        prompts_data = load_prompts()
        categories = list(prompts_data.keys()) if prompts_data else ["Default"]

        all_prompts = set()
        for category_prompts in prompts_data.values():
            if isinstance(category_prompts, dict):
                all_prompts.update(k for k in category_prompts.keys() if not _is_hidden_category_entry_key(k))
        all_prompts.add("")

        return {
            "required": {
                "category": (categories, {"default": categories[0] if categories else "Default"}),
                "name": (sorted(all_prompts), {"default": ""}),
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "Enter prompt text",
                    "dynamicPrompts": False,
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    CATEGORY = "Prompt Manager Lite"
    DESCRIPTION = "Minimal prompt library manager: selector + text editor + prompt output."
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "get_prompt"

    @classmethod
    def IS_CHANGED(cls, category, name, text="", **kwargs):
        return (category, name, text)

    def get_prompt(self, category, name, text="", **kwargs):
        return (text if text else "",)


# ---------------------------------------------------------------------------
# HTTP API (subset of /prompt-manager-advanced/* used by the browser UI)
# ---------------------------------------------------------------------------

def _json_error(error, status=200):
    return web.json_response({"success": False, "error": error}, status=status)


@PromptServer.instance.routes.get("/prompt-manager-lite/get-prompts")
async def lite_get_prompts(request):
    try:
        return web.json_response(load_prompts())
    except Exception as e:
        print(f"[PromptManagerLite] Error in get_prompts API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/save-prompt")
async def lite_save_prompt(request):
    try:
        data = await request.json()
        category = str(data.get("category", "")).strip()
        name = str(data.get("name", "")).strip()
        text = str(data.get("text", "")).strip()
        old_category = str(data.get("old_category", "")).strip() or category
        old_name = str(data.get("old_name", "")).strip() or name

        if not category or not name:
            return _json_error("Category and name are required")

        prompts = load_prompts()
        if category not in prompts:
            prompts[category] = {}

        source_prompts = prompts.get(old_category) if isinstance(prompts.get(old_category), dict) else {}
        existing_prompt = {}
        existing_old_name = None
        if isinstance(source_prompts, dict):
            existing_old_name = next(
                (k for k in source_prompts.keys() if str(k).lower() == old_name.lower()), None)
            if existing_old_name:
                existing_prompt = source_prompts.get(existing_old_name, {})

        # Conflict check in the target category (excluding the entry being renamed)
        target_prompts = prompts[category]
        exclude = existing_old_name if (old_category == category and existing_old_name) else None
        existing_target_name = next(
            (k for k in target_prompts.keys()
             if str(k).lower() == name.lower() and not _is_hidden_category_entry_key(k) and k != exclude),
            None)
        if existing_target_name and not (
            existing_old_name and old_category == category
            and str(existing_target_name).lower() == str(existing_old_name).lower()
        ):
            return _json_error(f"A prompt named '{existing_target_name}' already exists in '{category}'")

        # Remove the old entry when renaming/moving
        if existing_old_name and (old_category != category or existing_old_name != name):
            source_prompts.pop(existing_old_name, None)

        # Same-name-different-casing cleanup
        casing_name = next(
            (k for k in target_prompts.keys()
             if str(k).lower() == name.lower() and not _is_hidden_category_entry_key(k) and k != name),
            None)
        if casing_name:
            if not existing_prompt:
                existing_prompt = target_prompts.get(casing_name, {})
            del target_prompts[casing_name]

        prompt_data = {"prompt": text}

        # Preserve unmanaged fields from the existing record (loras, trigger
        # words, workflow data, ...). Lite only manages the text itself.
        for extra_key, extra_val in existing_prompt.items():
            if extra_key not in _MANAGED_KEYS:
                prompt_data[extra_key] = extra_val

        thumbnail = data.get("thumbnail")
        if thumbnail is None:
            thumbnail = existing_prompt.get("thumbnail")
        if thumbnail:
            prompt_data["thumbnail"] = thumbnail

        nsfw = data.get("nsfw")
        if nsfw is not None:
            prompt_data["nsfw"] = bool(nsfw)
        elif existing_prompt.get("nsfw"):
            prompt_data["nsfw"] = existing_prompt["nsfw"]

        prompt_data["saved_at"] = datetime.utcnow().isoformat() + "Z"

        prompts[category][name] = prompt_data
        save_prompts(prompts)
        return web.json_response({"success": True, "prompts": prompts})
    except Exception as e:
        print(f"[PromptManagerLite] Error in save_prompt API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/save-category")
async def lite_save_category(request):
    try:
        data = await request.json()
        category_name = str(data.get("category_name", "")).strip()
        if not category_name:
            return _json_error("Category name is required")

        prompts = load_prompts()
        existing_lower = {k.lower(): k for k in prompts.keys()}
        if category_name.lower() in existing_lower:
            return _json_error(f"Category already exists as '{existing_lower[category_name.lower()]}'")

        cat_data = {}
        if data.get("nsfw", False):
            cat_data["__meta__"] = {"nsfw": True}
        prompts[category_name] = cat_data
        save_prompts(prompts)
        return web.json_response({"success": True, "prompts": prompts})
    except Exception as e:
        print(f"[PromptManagerLite] Error in save_category API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/rename-category")
async def lite_rename_category(request):
    try:
        data = await request.json()
        old_category = str(data.get("old_category", "")).strip()
        new_category = str(data.get("new_category", "")).strip()
        if not old_category or not new_category:
            return _json_error("Both old and new category names are required")

        prompts = load_prompts()
        if old_category not in prompts:
            return _json_error(f"Category '{old_category}' not found")

        existing_lower = {k.lower(): k for k in prompts.keys() if k.lower() != old_category.lower()}
        if new_category.lower() in existing_lower:
            return _json_error(f"Category already exists as '{existing_lower[new_category.lower()]}'")

        prompts[new_category] = prompts[old_category]
        del prompts[old_category]
        save_prompts(prompts)
        return web.json_response({"success": True, "prompts": prompts, "new_category": new_category})
    except Exception as e:
        print(f"[PromptManagerLite] Error in rename_category API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/delete-category")
async def lite_delete_category(request):
    try:
        data = await request.json()
        category = str(data.get("category", "")).strip()
        if not category:
            return _json_error("Category name is required")

        prompts = load_prompts()
        if category not in prompts:
            return _json_error("Category not found")

        del prompts[category]
        save_prompts(prompts)
        return web.json_response({"success": True, "prompts": prompts})
    except Exception as e:
        print(f"[PromptManagerLite] Error in delete_category API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/delete-prompt")
async def lite_delete_prompt(request):
    try:
        data = await request.json()
        category = str(data.get("category", "")).strip()
        name = str(data.get("name", "")).strip()
        if not category or not name:
            return _json_error("Category and prompt name are required")

        prompts = load_prompts()
        if category not in prompts or name not in prompts[category]:
            return _json_error("Prompt not found")

        del prompts[category][name]
        save_prompts(prompts)
        return web.json_response({"success": True, "prompts": prompts})
    except Exception as e:
        print(f"[PromptManagerLite] Error in delete_prompt API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/rename-prompt")
async def lite_rename_prompt(request):
    try:
        data = await request.json()
        category = str(data.get("category", "")).strip()
        old_name = str(data.get("old_name", "")).strip()
        new_name = str(data.get("new_name", "")).strip()
        new_category = str(data.get("new_category", "")).strip() or category

        if not category or not old_name or not new_name:
            return _json_error("Category, old name, and new name are required")

        prompts = load_prompts()
        if category not in prompts or old_name not in prompts[category]:
            return _json_error("Prompt not found")
        if new_category not in prompts:
            return _json_error(f"Category '{new_category}' not found")

        target_prompts = prompts[new_category]
        if category == new_category:
            existing_lower = {
                k.lower(): k for k in target_prompts.keys()
                if not _is_hidden_category_entry_key(k) and k.lower() != old_name.lower()
            }
        else:
            existing_lower = {
                k.lower(): k for k in target_prompts.keys()
                if not _is_hidden_category_entry_key(k)
            }
        if new_name.lower() in existing_lower:
            return _json_error(f"A prompt named '{existing_lower[new_name.lower()]}' already exists in '{new_category}'")

        entry = prompts[category].pop(old_name)
        prompts[new_category][new_name] = entry
        save_prompts(prompts)
        return web.json_response({
            "success": True, "prompts": prompts,
            "new_name": new_name, "new_category": new_category,
        })
    except Exception as e:
        print(f"[PromptManagerLite] Error in rename_prompt API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/save-thumbnail")
async def lite_save_thumbnail(request):
    try:
        data = await request.json()
        category = str(data.get("category", "")).strip()
        name = str(data.get("name", "")).strip()
        thumbnail = data.get("thumbnail")

        if not category or not name:
            return _json_error("Category and name required")

        prompts = load_prompts()
        if category not in prompts or name not in prompts[category]:
            return _json_error("Prompt not found")

        if thumbnail:
            prompts[category][name]["thumbnail"] = thumbnail
        elif "thumbnail" in prompts[category][name]:
            del prompts[category][name]["thumbnail"]

        save_prompts(prompts)
        return web.json_response({"success": True})
    except Exception as e:
        print(f"[PromptManagerLite] Error in save_thumbnail API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/toggle-nsfw")
async def lite_toggle_nsfw(request):
    try:
        data = await request.json()
        toggle_type = str(data.get("type", "")).strip()
        category = str(data.get("category", "")).strip()
        name = str(data.get("name", "")).strip()

        if not category:
            return _json_error("Category is required")

        prompts = load_prompts()
        if category not in prompts:
            return _json_error("Category not found")

        if toggle_type == "category":
            meta = prompts[category].get("__meta__", {})
            meta["nsfw"] = not meta.get("nsfw", False)
            prompts[category]["__meta__"] = meta
        elif toggle_type == "prompt":
            if not name or name not in prompts[category]:
                return _json_error("Prompt not found")
            prompts[category][name]["nsfw"] = not prompts[category][name].get("nsfw", False)
        else:
            return _json_error("Invalid type, must be 'category' or 'prompt'")

        save_prompts(prompts)
        return web.json_response({"success": True, "prompts": prompts})
    except Exception as e:
        print(f"[PromptManagerLite] Error in toggle_nsfw API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/import-prompts")
async def lite_import_prompts(request):
    try:
        data = await request.json()
        imported_data = data.get("data", {})
        mode = str(data.get("mode", "replace_existing") or "replace_existing").strip().lower()

        if not isinstance(imported_data, dict):
            return _json_error("Invalid data format")

        prompts = {} if mode == "replace" else load_prompts()

        imported_prompts = 0
        skipped_prompts = 0
        created_categories = 0

        for category, category_prompts in imported_data.items():
            if not isinstance(category_prompts, dict):
                continue
            if category not in prompts:
                prompts[category] = {}
                created_categories += 1

            for prompt_name, prompt_data in category_prompts.items():
                if not isinstance(prompt_data, dict):
                    continue
                if _is_hidden_category_entry_key(prompt_name):
                    if mode != "skip_existing" or prompt_name not in prompts[category]:
                        prompts[category][prompt_name] = prompt_data
                    continue
                if prompt_name in prompts[category] and mode == "skip_existing":
                    skipped_prompts += 1
                    continue

                normalized = dict(prompt_data)
                normalized.setdefault("prompt", prompt_data.get("prompt", ""))
                prompts[category][prompt_name] = normalized
                imported_prompts += 1

        save_prompts(prompts)
        return web.json_response({
            "success": True, "prompts": prompts,
            "imported_prompts": imported_prompts,
            "skipped_prompts": skipped_prompts,
            "created_categories": created_categories,
        })
    except Exception as e:
        print(f"[PromptManagerLite] Error in import_prompts API: {e}")
        return _json_error(str(e), 500)


def _safe_abspath(path):
    """Resolve a user-provided path, restricting it to the ComfyUI user directory."""
    user_dir = os.path.abspath(folder_paths.get_user_directory())
    full = os.path.abspath(path)
    if os.path.commonpath([user_dir, full]) != user_dir:
        return None
    return full


@PromptServer.instance.routes.post("/prompt-manager-lite/load-prompts-file")
async def lite_load_prompts_file(request):
    try:
        data = await request.json()
        file_path = _safe_abspath(data.get("path", ""))
        if not file_path:
            return _json_error("Path is required")
        if not os.path.isfile(file_path):
            return _json_error("JSON file not found", 404)

        with open(file_path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if not isinstance(loaded, dict):
            return _json_error("Invalid JSON data format", 400)
        return web.json_response({"success": True, "data": loaded, "path": file_path})
    except Exception as e:
        print(f"[PromptManagerLite] Error in load_prompts_file API: {e}")
        return _json_error(str(e), 500)


@PromptServer.instance.routes.post("/prompt-manager-lite/export-prompts-file")
async def lite_export_prompts_file(request):
    try:
        data = await request.json()
        export_path = _safe_abspath(data.get("path", ""))
        exported_data = data.get("data", {})

        if not export_path:
            return _json_error("Export path is required")
        if not isinstance(exported_data, dict):
            return _json_error("Invalid data format")
        if not os.path.isdir(os.path.dirname(export_path)):
            return _json_error("Target folder does not exist")

        if not atomic_save(export_path, exported_data, "PromptManagerLiteExport"):
            return _json_error("Failed to save export file", 500)
        return web.json_response({"success": True, "path": export_path})
    except Exception as e:
        print(f"[PromptManagerLite] Error in export_prompts_file API: {e}")
        return _json_error(str(e), 500)
