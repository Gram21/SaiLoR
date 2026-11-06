/// <reference types="vite/client" />

/** The app's version, injected from package.json by vite.config.ts at build time. */
declare const __APP_VERSION__: string

// [impl->req~plt-444~1]
/** True only in the online demo build (`npm run build:demo`), set by vite.config.ts. */
declare const __DEMO__: boolean
