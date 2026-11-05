// Named rules for steps and text that apply only in some installs. Each tests the answers
// of bwat.answers and says null while the answer it reads is not given yet, so the page
// shows the step marked "Applies when ..." instead of hiding it.
export type Condition = { label: string; test(answers: Map<string, string>): boolean | null };

const value = (answers: Map<string, string>, key: string) => (answers.get(key) ?? '').trim();

export const CONDITIONS: Record<string, Condition> = {
  'board-app': {
    label: 'the address is https',
    test(answers) {
      const url = value(answers, 'BWAT_PUBLIC_URL');
      return url ? url.startsWith('https://') : null;
    },
  },
  production: {
    label: 'BWAT_MODE is production',
    test(answers) {
      const mode = value(answers, 'BWAT_MODE');
      return mode ? mode === 'production' : null;
    },
  },
};

/** Every condition's label and whether it applies now (null: the answer is not given yet). */
export function conditionStates(answers: Map<string, string>): Record<string, { label: string; applies: boolean | null }> {
  return Object.fromEntries(Object.entries(CONDITIONS).map(([name, c]) => [name, { label: c.label, applies: c.test(answers) }]));
}

/** Whether a step's condition lets it apply: none, or one not known to be false yet. */
export function whenApplies(when: string | null | undefined, states: ReturnType<typeof conditionStates>): boolean {
  return !when || states[when]?.applies !== false;
}
