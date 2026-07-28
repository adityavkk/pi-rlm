/** Run-local gate preventing external-operation finalizers from writing after terminalization begins. */

export interface RunOperationAuthority {
  readonly active: boolean;
  close(): void;
}

export const createRunOperationAuthority = (): RunOperationAuthority => {
  let active = true;
  return {
    get active() { return active; },
    close: () => { active = false; },
  };
};
