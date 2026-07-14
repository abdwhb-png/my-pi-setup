// Bridge to pi-roles/api. Consumers import from this bridge instead of
// depending on pi-roles subpaths directly. If pi-roles changes its public
// entry points, only this file needs updating.
export {
  ACTIVE_ROLE_ENTRY_TYPE,
  ROLE_SWITCH_PROCESSED_TYPE,
  ROLE_SWITCH_REQUEST_ENTRY_TYPE,
  findLatestActiveRoleState,
  findUnprocessedSwitchRequest,
  writeActiveRoleState,
  writeRoleSwitchRequest,
  type ActiveRoleState,
  type RoleSwitchRequest,
  type SwitchProcessedPayload,
} from "pi-roles/api";
