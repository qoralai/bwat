/** A small valid dictionary: one word, one person, one correction. */
export const WORDS = {
  targets: [{ id: 'bwat', canonical: 'Bwat', hardness: 'hard', proper_noun: true, scopes: ['body'] }],
  people: [{ id: 'zed', canonical: 'Zedekiah' }],
  aliases: [{ alias: 'be what', target_id: 'bwat', hardness: 'hard', scopes: ['body'] }],
  house_rule: 'kept as sent',
};
