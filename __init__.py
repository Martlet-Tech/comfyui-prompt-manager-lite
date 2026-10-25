"""Prompt Manager Lite - a minimal prompt library node for ComfyUI."""
__version__ = "1.0.0"

from .nodes.prompt_manager_lite import PromptManagerLite, check_backup_on_startup, get_data_path

NODE_CLASS_MAPPINGS = {
    "PromptManagerLite": PromptManagerLite,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptManagerLite": "Prompt Manager Lite",
}

WEB_DIRECTORY = "./js"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

check_backup_on_startup()
print("[PromptManagerLite] Node registered: Prompt Manager Lite")
