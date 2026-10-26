// Where the analyzer lives. `/` is the marketing landing; the app itself runs
// under `/app`. `/app` redirects to the upload today, so a different home for
// the installed app can replace that redirect later without touching callers.
export const APP_HOME = '/app'
export const UPLOAD_PATH = '/app/upload'
// Opens the landing even for returning users and the installed PWA.
export const LANDING_PATH = '/?landing'

/** Path of a demo from history (`/app/:id`). */
export function demoPath(id: string): string {
  return `${APP_HOME}/${id}`
}
