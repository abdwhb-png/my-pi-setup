# Session YOLO permission

Use `/yolo-permission on`, `/yolo-permission off`, or `/yolo-permission status`. Default is OFF. `on` allows eligible permission-system asks in this session; explicit denies still block. The permission-system authorizer cannot auto-approve `path` or `external_directory` asks, so those may still prompt.

The last explicit ON/OFF choice is saved in the Pi session transcript (not sent to the model). `/reload` and reopening the **same saved session** restore it. A new or forked session starts OFF. Navigating the session tree restores the choice from the active branch. `/yolo-permission off` revokes the saved choice; quitting does not.

This does not enable YOLO globally. Pi does not write a new session file until it has an assistant response; an unsaved session cannot be reopened to restore its choice.
