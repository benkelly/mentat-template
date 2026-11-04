// Who may sign in. GitHub logins can be renamed and then claimed by someone
// else, so match the numeric user ID, which never changes.

export interface GitHubUser {
  id?: number;
  login?: string;
}

export function isAllowedUser(user: GitHubUser, allowedId: string | undefined): boolean {
  if (!allowedId || !/^\d+$/.test(allowedId)) return false;
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return false;
  return String(user.id) === allowedId;
}
