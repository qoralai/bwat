import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, getJson, ONCE, sendJsonForBody, sessionGone } from './api';

type Word = { id: string; canonical: string; [key: string]: unknown };
/** `to` is the "corrected to" spelling as typed, kept only until the save resolves it to a `target_id`. */
type Correction = { alias: string; target_id: string; require_capitalised?: boolean; to?: string; [key: string]: unknown };
type Vocabulary = { targets: Word[]; aliases: Correction[]; people?: Word[]; [key: string]: unknown };
type DictionaryView = { state: string; revision: number | null; payload: Vocabulary | null };
const EMPTY: Vocabulary = { targets: [], aliases: [], people: [] };
const replace = <T,>(rows: T[], index: number, change: Partial<T>) => rows.map((r, i) => i === index ? { ...r, ...change } : r);
const fetchDictionary = () => getJson<{ dictionary: DictionaryView }>('/v1/console/corrections');
const STALE = 'Someone else changed the dictionary. Reload to see their changes before saving again.';
/** A word as the full editor adds one. */
const newWord = (canonical: string): Word => ({ id: crypto.randomUUID(), canonical, hardness: 'hard', proper_noun: true, scopes: ['body'] });
/**
 * The vocabulary as stored: each typed "corrected to" spelling points at the word or person
 * spelt that way (exactly, else ignoring case), or at a new word added for it.
 */
function resolveTyped(vocab: Vocabulary): Vocabulary {
  const targets = [...vocab.targets];
  const aliases = vocab.aliases.map(({ to, ...correction }) => {
    if (to === undefined) return correction;
    const spelling = to.trim();
    const words = [...targets, ...(vocab.people ?? [])];
    const word = words.find((w) => w.canonical === spelling) ?? words.find((w) => w.canonical.toLowerCase() === spelling.toLowerCase());
    if (word) return { ...correction, target_id: word.id };
    const added = newWord(spelling);
    targets.push(added);
    return { ...correction, target_id: added.id };
  });
  return { ...vocab, targets, aliases };
}

function Editor({ initial, reload }: { initial: DictionaryView; reload: () => void }) {
  const [vocab, setVocab] = useState(initial.payload ?? EMPTY);
  const [baseline, setBaseline] = useState(JSON.stringify(initial.payload ?? EMPTY));
  const [revision, setRevision] = useState(initial.revision);
  // A word the server just took gets a brief underline in the logo's orange arc.
  const [fresh, setFresh] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: async () => {
      const result = await sendJsonForBody('PUT', '/v1/console/corrections', { expectedRevision: revision, payload: resolveTyped(vocab) });
      return (result as { dictionary: DictionaryView }).dictionary;
    },
    onSuccess: (saved) => {
      const before = (JSON.parse(baseline) as Vocabulary).targets.map((word) => word.id);
      setFresh(saved.payload!.targets.map((word) => word.id).filter((id) => !before.includes(id)));
      setVocab(saved.payload!); setBaseline(JSON.stringify(saved.payload)); setRevision(saved.revision);
    },
  });
  const choices = [...vocab.targets, ...(vocab.people ?? [])];
  const problems: string[] = [];
  vocab.targets.forEach((word, i) => { if (!word.canonical.trim()) problems.push(`Enter a spelling for word ${i + 1}.`); });
  const spellingById = new Map(choices.map((word) => [word.id, word.canonical]));
  const spellingOf = (correction: Correction) => correction.to ?? spellingById.get(correction.target_id) ?? '';
  // The server refuses a correction whose heard-as text is some other word's spelling, compared
  // as stored: a word untrimmed, a typed spelling trimmed as the save stores it.
  const spellings = new Set([...choices.map((word) => word.canonical), ...vocab.aliases.flatMap((c) => c.to === undefined ? [] : [c.to.trim()])].map((s) => s.toLowerCase()));
  const seen = new Set<string>();
  vocab.aliases.forEach((correction, i) => {
    const key = correction.alias.trim().toLowerCase();
    const spelling = spellingOf(correction).trim();
    if (!key) problems.push(`Enter the heard-as spelling for correction ${i + 1}.`);
    if (key && seen.has(key)) problems.push(`The spelling “${correction.alias}” is corrected twice.`);
    seen.add(key);
    if (!spelling) problems.push(`Enter what correction ${i + 1} should say.`);
    if (key && spellings.has(key) && spelling.toLowerCase() !== key) problems.push(`“${correction.alias}” is already the spelling of another word.`);
  });
  const dirty = JSON.stringify(vocab) !== baseline;
  const error = save.error;
  const serverProblems = error instanceof ApiError && Array.isArray(error.body.problems) ? error.body.problems : [];
  return <>
    {!initial.payload && <p className="notice">No custom dictionary is saved. Add the words and corrections your team uses.</p>}
    <fieldset disabled={save.isPending} style={{ border: 0, padding: 0, margin: 0 }}>
      <section className="dictionary-part" aria-labelledby="dictionary-words">
        <h3 id="dictionary-words">Words</h3>
        <p className="muted">The preferred spellings of product names and team terms.</p>
        <ul className="rows">{vocab.targets.map((word, i) => <li className="row" key={word.id}>
          <input type="text" className={fresh.includes(word.id) ? 'fresh' : undefined} aria-label={`Word ${i + 1}`} value={word.canonical} onChange={(e) => setVocab({ ...vocab, targets: replace(vocab.targets, i, { canonical: e.target.value }) })} />
          <button className="button remove" type="button" aria-label={`Remove word ${i + 1}`} onClick={() => setVocab({ ...vocab, targets: vocab.targets.filter((_, j) => j !== i) })}>Remove</button>
        </li>)}</ul>
        <button className="button" type="button" onClick={() => setVocab({ ...vocab, targets: [...vocab.targets, newWord('')] })}>Add a word</button>
        {!!vocab.people?.length && <p className="muted">People: {vocab.people.map((p) => p.canonical).join(', ')}</p>}
      </section>
      <section className="dictionary-part" aria-labelledby="dictionary-corrections">
        <h3 id="dictionary-corrections">Corrections</h3>
        <p className="muted" id="dictionary-corrections-hint">What the transcriber hears → what the transcript should say. Type a spelling or choose a suggestion; a new spelling is added to Words when you save.</p>
        <datalist id="dictionary-choices">{choices.map((word) => <option key={word.id} value={word.canonical} />)}</datalist>
        <ul className="rows">{vocab.aliases.map((correction, i) => <li className="row" key={i}>
          <input type="text" aria-label={`Heard as ${i + 1}`} value={correction.alias} onChange={(e) => setVocab({ ...vocab, aliases: replace(vocab.aliases, i, { alias: e.target.value }) })} />
          <span aria-hidden="true">→</span>
          <input type="text" list="dictionary-choices" aria-label={`Corrected to ${i + 1}`} value={spellingOf(correction)} aria-describedby="dictionary-corrections-hint" onChange={(e) => {
            // A spelling that is already a word points at that word, so the row follows its renames.
            const word = e.target.value ? choices.find((w) => w.canonical === e.target.value) : undefined;
            setVocab({ ...vocab, aliases: replace(vocab.aliases, i, word ? { target_id: word.id, to: undefined } : { to: e.target.value }) });
          }} />
          <label><input type="checkbox" checked={!!correction.require_capitalised} onChange={(e) => setVocab({ ...vocab, aliases: replace(vocab.aliases, i, { require_capitalised: e.target.checked }) })} /> Only when capitalized</label>
          <button className="button remove" type="button" aria-label={`Remove correction ${i + 1}`} onClick={() => setVocab({ ...vocab, aliases: vocab.aliases.filter((_, j) => j !== i) })}>Remove</button>
        </li>)}</ul>
        <button className="button" type="button" onClick={() => setVocab({ ...vocab, aliases: [...vocab.aliases, { alias: '', target_id: '', to: '', hardness: 'hard', scopes: ['body'] }] })}>Add a correction</button>
      </section>
      {problems.length > 0 && <div className="notice warn"><p>Fix these before saving:</p><ul>{[...new Set(problems)].map((p) => <li key={p}>{p}</li>)}</ul></div>}
      <div className="save-bar">
        <button className="button primary" type="button" disabled={!dirty || !!problems.length} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save dictionary'}</button>
        <button className="button" type="button" onClick={reload}>Reload dictionary</button>
      </div>
    </fieldset>
    {error && !sessionGone(error) && <div role="alert" className="error">
      <p>{error instanceof ApiError && error.code === 'stale' ? STALE
        : serverProblems.length ? 'Fix these corrections, then save again:'
          : 'We could not confirm the save. Your edits are still here. Reload to check what is stored.'}</p>
      {!!serverProblems.length && <ul>{serverProblems.map((p) => <li key={String(p)}>{String(p)}</li>)}</ul>}
    </div>}
    <p role="status">{save.isSuccess && !dirty ? 'Dictionary saved.' : ''}</p>
  </>;
}

export function Dictionary() {
  const query = useQuery({ queryKey: ['dictionary'], queryFn: fetchDictionary, ...ONCE });
  const reload = () => { void query.refetch(); };
  // At the foot of Settings, Cards: its own save, as anyone signed in keeps it.
  return <section className="block corrections" aria-labelledby="settings-dictionary">
    <h4 id="settings-dictionary" className="eyebrow">Dictionary</h4>
    <p className="muted">Manage preferred spellings and common transcription mistakes.</p>
    <p className="muted">Saved corrections apply to new speech after the bot’s next settings check (about 30 seconds). Original wording is retained. Typed chat and earlier transcripts are not changed.</p>
    {query.isPending && <p role="status">Loading the dictionary…</p>}
    {query.isError && !sessionGone(query.error) && <div role="alert"><p>We couldn’t load the dictionary.</p><button className="button" onClick={reload}>Reload dictionary</button></div>}
    {query.data && <Editor key={query.dataUpdatedAt} initial={query.data.dictionary} reload={reload} />}
  </section>;
}
