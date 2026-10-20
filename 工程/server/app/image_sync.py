"""Only image transfer controls are interpreted; task content and unknown fields stay intact."""
from __future__ import annotations

from copy import deepcopy


def _state(value):
    return isinstance(value, dict) and isinstance(value.get("sync"), bool) and isinstance(value.get("updatedAt"), str)


def cloud_image_projection(incoming: dict, previous: dict | None) -> dict:
    """Keep the newest per-image controls even when an old client saves a stale vault.

    A client that does not understand imageSync must not re-upload a local-only or
    deleted image from an earlier cached task. No task, image or unknown field is
    reconstructed; only excluded image references are removed from the cloud copy.
    """
    result = deepcopy(incoming)
    data = result.get("data")
    old = previous.get("data") if isinstance(previous, dict) else None
    if not isinstance(data, dict):
        return result
    current = data.get("imageSync")
    stored = old.get("imageSync") if isinstance(old, dict) else None
    controls = dict(stored) if isinstance(stored, dict) else {}
    if isinstance(current, dict):
        for key, value in current.items():
            before = controls.get(key)
            if not _state(before) or _state(value) and value["updatedAt"] >= before["updatedAt"]:
                controls[key] = value
            elif key not in controls:
                controls[key] = value
    if controls:
        data["imageSync"] = controls
    tasks = data.get("tasks", [])
    for task in tasks if isinstance(tasks, list) else []:
        if not isinstance(task, dict):
            continue
        subs = task.get("subtasks", [])
        owners = [task, *(sub for sub in subs if isinstance(sub, dict))] if isinstance(subs, list) else [task]
        for owner in owners:
            images = owner.get("images")
            if not isinstance(images, list):
                continue
            def included(image):
                if not isinstance(image, dict):
                    return True
                marker = controls.get(image.get("id")) if isinstance(image.get("id"), str) else None
                if _state(marker):
                    return marker["sync"] and not marker.get("deletedAt")
                return image.get("sync") is not False
            owner["images"] = [image for image in images if included(image)]
    return result
