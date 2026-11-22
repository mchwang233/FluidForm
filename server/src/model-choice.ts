// Which configured models a task may use: membership CLIs or not, only CLIs, or only the models it
// names (super-partner plan --no-use-cli / --only-cli / --model).
export const configuredFor = (configured: Set<string>, useCli: boolean) =>
  useCli ? configured : new Set([...configured].filter((modelId) => !modelId.startsWith("cli:")));

/** The models a task may use: those configured, kept to its own choice (only these models, only
 *  membership CLIs, no CLIs). */
export function chosenFor(configured: Set<string>, choice: { use_cli: boolean; cli_only?: boolean; only_models?: string[] }): Set<string> {
  let found = configuredFor(configured, choice.use_cli || Boolean(choice.cli_only));
  if (choice.cli_only) found = new Set([...found].filter((modelId) => modelId.startsWith("cli:")));
  if (choice.only_models?.length) found = new Set([...found].filter((modelId) => choice.only_models!.includes(modelId)));
  return found;
}
