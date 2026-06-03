from __future__ import annotations

from ..controllers import WebcamGroupController
from ..adapters import WebcamModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import InteractiveGroupModuleBase


class WebcamInteractiveGroupModule(WebcamGroupController, InteractiveGroupModuleBase):
  canonical_group_id = "webcam_main"
  adapter_cls = WebcamModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    sensor_inputs=("camera_capture",),
    phone_outputs=("camera_controls",),
    audience_outputs=("camera_preview",),
  )


MODULE = WebcamInteractiveGroupModule()
DEFINITION = MODULE.definition()
