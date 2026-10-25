"""Prompt Manager Lite - minimal prompt library nodes for ComfyUI."""
__version__ = "1.1.0"

from .nodes.prompt_manager_lite import PromptManagerLite, check_backup_on_startup, get_data_path
from .nodes.prompt_snippets import PromptSnippets

NODE_CLASS_MAPPINGS = {
    "PromptManagerLite": PromptManagerLite,
    "PromptSnippets": PromptSnippets,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptManagerLite": "Prompt Manager Lite",
    "PromptSnippets": "Prompt Snippets",
}

WEB_DIRECTORY = "./js"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

check_backup_on_startup()
print("[PromptManagerLite] Node registered: Prompt Manager Lite")
