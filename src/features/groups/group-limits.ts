/**
 * D6 (docs/09): "5 grupos ativos" = five active memberships in non-archived
 * groups; an own group counts, a pending request does not. The server enforces
 * it (private.app_limits.max_active_groups_per_profile, migration 0015, and
 * GROUP_LIMIT); the app only shows it on the groups scoreboard.
 */
export const MAX_ACTIVE_GROUPS = 5;
