// This weblab's version. A release build stamps in the tag it was built
// from (scripts/build.ts). Anything else, run from source or built by
// hand, is "dev". Nothing in the repository holds the version, so a
// release is a tag on main and nothing more.
declare const WEBLAB_VERSION: string | undefined;

export const VERSION: string = typeof WEBLAB_VERSION === "string" ? WEBLAB_VERSION : "dev";
