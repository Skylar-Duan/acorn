"""Synthetic account integration; never touches production accounts or credentials."""
from __future__ import annotations
import copy
from test_api import client, auth, signup


def env(images, controls=None):
    data = {"tasks": [{"id": "task", "title": "New text", "future": {"keep": True}, "images": images, "subtasks": [{"id": "sub", "images": images}]}], "futureTop": [1, 2]}
    if controls is not None:
        data["imageSync"] = controls
    return {"app": "acorn", "schema": 8, "data": data}


def test_sync_filters_local_only_and_keeps_unknown_data():
    token = signup("image-projection@example.com")
    image = {"id": "local", "dataUrl": "data:image/jpeg;base64,NOT-TRANSFERRED", "sync": False, "future": "preserve locally"}
    original = env([image])
    before = copy.deepcopy(original)
    response = client.put("/api/sync", headers=auth(token), json={"base_rev": 0, "data": original})
    assert response.status_code == 200, response.text
    cloud = client.get("/api/sync", headers=auth(token)).json()["data"]
    assert original == before
    assert cloud["data"]["tasks"][0]["images"] == []
    assert cloud["data"]["tasks"][0]["subtasks"][0]["images"] == []
    assert cloud["data"]["tasks"][0]["future"] == {"keep": True}
    assert cloud["data"]["futureTop"] == [1, 2]


def test_old_client_cannot_restore_cloud_disabled_or_deleted_images():
    token = signup("image-tombstone@example.com")
    controls = {"off": {"sync": False, "updatedAt": "2026-10-20T01:00:00Z"}, "gone": {"sync": False, "updatedAt": "2026-10-20T01:00:00Z", "deletedAt": "2026-10-20T01:00:00Z"}}
    first = client.put("/api/sync", headers=auth(token), json={"base_rev": 0, "data": env([], controls)})
    assert first.status_code == 200
    stale = env([{"id": key, "dataUrl": "old-cache-will-not-be-stored"} for key in controls], {key: {"sync": True, "updatedAt": "2026-10-19T01:00:00Z"} for key in controls})
    response = client.put("/api/sync", headers=auth(token), json={"base_rev": first.json()["rev"], "data": stale})
    assert response.status_code == 200, response.text
    cloud = client.get("/api/sync", headers=auth(token)).json()["data"]["data"]
    assert cloud["imageSync"] == controls
    assert cloud["tasks"][0]["images"] == []
    assert cloud["tasks"][0]["subtasks"][0]["images"] == []


def test_newer_sync_control_can_enable_upload_and_conflict_keeps_revision():
    from test_ultra import image
    token = signup("image-enable@example.com")
    disabled = {"image-1": {"sync": False, "updatedAt": "2026-10-20T01:00:00Z"}}
    first = client.put("/api/sync", headers=auth(token), json={"base_rev": 0, "data": env([], disabled)})
    enabled = {"image-1": {"sync": True, "updatedAt": "2026-10-20T02:00:00Z", "future": {"keep": 1}}}
    payload = env([image()], enabled)
    response = client.put("/api/sync", headers=auth(token), json={"base_rev": first.json()["rev"], "data": payload})
    assert response.status_code == 200, response.text
    cloud = client.get("/api/sync", headers=auth(token)).json()
    assert cloud["data"]["data"]["tasks"][0]["images"] == [image()]
    assert cloud["data"]["data"]["imageSync"] == enabled
    rejected = client.put("/api/sync", headers=auth(token), json={"base_rev": first.json()["rev"], "data": env([], disabled)})
    assert rejected.status_code == 409
    assert client.get("/api/sync", headers=auth(token)).json() == cloud


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test(); print("PASS", name)
