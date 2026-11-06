// [impl->req~plt-449~1]
/**
 * True only in the online demo build (`npm run build:demo`). A build-time
 * constant: the normal build folds it to `false` and drops every branch that
 * reads it.
 */
export const DEMO_MODE: boolean = __DEMO__
