// "@socle/sdk": what an app's screens import to talk to the platform. Served once
// by the platform (never bundled into an app), so updating the platform updates every app.
export { api, refreshAll, useQuery, type QueryState } from './data.ts';
export { ApiError } from './http.ts';
export { install, logout, push, useMe, usePush, type PushState } from './platform.ts';
export { start } from './start.tsx';
export type { Member } from './boot.ts';
