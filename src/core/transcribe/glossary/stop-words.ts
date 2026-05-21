/**
 * High-frequency German + English stop-word list for the fuzzy session glossary.
 *
 * Any token in this set is NEVER rewritten by `applySessionGlossary()`, even
 * when it sits within edit distance of a session term (a contact name, an API
 * profile name, a workflow name, a thread title).
 *
 * Why this exists: STT post-processing was rewriting ordinary spoken words into
 * proper nouns from the user's context — "bitte" → "Britta" (a contact),
 * "wollen" → "Olten" (a place). The bug was the fuzzy matcher treating common
 * function words as fair game. This list protects them.
 *
 * Scope: function words (articles, prepositions, conjunctions, pronouns),
 * modal + auxiliary verbs, the most common lexical verbs and nouns, numerals,
 * and politeness words — for both German and English. It is intentionally broad
 * (~450 entries): a missed genuine correction is a minor annoyance; a corrupted
 * common word ("please" turned into a name) is a visible defect.
 *
 * All entries are stored lowercase. Matching is lowercase-exact.
 */

const GERMAN: readonly string[] = [
  // Articles + determiners
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines',
  'einem', 'einen', 'kein', 'keine', 'keiner', 'keines', 'keinem', 'keinen',
  'dieser', 'diese', 'dieses', 'diesem', 'diesen', 'jener', 'jene', 'jenes',
  'jeder', 'jede', 'jedes', 'jedem', 'jeden', 'alle', 'alles', 'allen', 'allem',
  'manche', 'mancher', 'manches', 'solche', 'solcher', 'solches', 'welche',
  'welcher', 'welches', 'welchem', 'welchen',
  // Pronouns
  'ich', 'mir', 'mich', 'mein', 'meine', 'meiner', 'meines', 'meinem', 'meinen',
  'du', 'dir', 'dich', 'dein', 'deine', 'deiner', 'deines', 'deinem', 'deinen',
  'er', 'sie', 'es', 'ihm', 'ihn', 'ihr', 'ihre', 'ihrer', 'ihres', 'ihrem',
  'ihren', 'sein', 'seine', 'seiner', 'seines', 'seinem', 'seinen',
  'wir', 'uns', 'unser', 'unsere', 'unserer', 'unseres', 'unserem', 'unseren',
  'euch', 'euer', 'eure', 'eurer', 'eures', 'eurem', 'euren',
  'man', 'jemand', 'niemand', 'etwas', 'nichts', 'wer', 'wen', 'wem', 'wessen',
  'sich', 'selbst', 'einander',
  // Prepositions
  'in', 'an', 'auf', 'aus', 'bei', 'mit', 'nach', 'seit', 'von', 'vom', 'zu',
  'zur', 'zum', 'für', 'durch', 'gegen', 'ohne', 'um', 'bis', 'über', 'unter',
  'vor', 'hinter', 'neben', 'zwischen', 'während', 'wegen', 'trotz', 'statt',
  'innerhalb', 'außerhalb', 'gegenüber', 'entlang', 'samt', 'nebst', 'laut',
  // Conjunctions + particles
  'und', 'oder', 'aber', 'denn', 'sondern', 'weil', 'dass', 'wenn', 'als',
  'ob', 'damit', 'obwohl', 'sobald', 'solange', 'bevor', 'nachdem', 'falls',
  'sowie', 'sowohl', 'weder', 'noch', 'entweder', 'doch', 'jedoch', 'zwar',
  'also', 'sonst', 'außerdem', 'trotzdem', 'dennoch', 'deshalb', 'darum',
  'daher', 'somit', 'folglich',
  // Adverbs (high frequency)
  'hier', 'dort', 'da', 'dorthin', 'hierhin', 'wo', 'wohin', 'woher', 'jetzt',
  'dann', 'damals', 'heute', 'gestern', 'morgen', 'immer', 'nie', 'niemals',
  'oft', 'manchmal', 'selten', 'bald', 'gerade', 'eben', 'schon', 'noch',
  'erst', 'wieder', 'sehr', 'ganz', 'gar', 'fast', 'kaum', 'nur', 'auch',
  'sogar', 'etwa', 'ziemlich', 'recht', 'wirklich', 'eigentlich', 'vielleicht',
  'sicher', 'natürlich', 'leider', 'hoffentlich', 'wohl', 'mal', 'einmal',
  'zweimal', 'oben', 'unten', 'vorne', 'hinten', 'links', 'rechts', 'drinnen',
  'draußen', 'überall', 'nirgends', 'irgendwo', 'so', 'genauso', 'ebenso',
  'anders', 'zusammen', 'allein', 'nicht', 'wie', 'warum', 'weshalb', 'wieso',
  'wann',
  // Modal verbs (all common forms)
  'können', 'kann', 'kannst', 'könnt', 'konnte', 'konnten', 'könnte', 'könnten',
  'müssen', 'muss', 'musst', 'müsst', 'musste', 'mussten', 'müsste', 'müssten',
  'wollen', 'will', 'willst', 'wollt', 'wollte', 'wollten', 'wollten',
  'sollen', 'soll', 'sollst', 'sollt', 'sollte', 'sollten',
  'dürfen', 'darf', 'darfst', 'dürft', 'durfte', 'durften', 'dürfte', 'dürften',
  'mögen', 'mag', 'magst', 'mögt', 'mochte', 'mochten', 'möchte', 'möchten',
  'möchtest', 'möchtet',
  // Auxiliary verbs
  'haben', 'habe', 'hast', 'hat', 'habt', 'hatte', 'hattest', 'hatten', 'hättet',
  'hätte', 'hätten', 'gehabt',
  'sein', 'bin', 'bist', 'ist', 'sind', 'seid', 'war', 'warst', 'waren', 'wart',
  'wäre', 'wären', 'gewesen',
  'werden', 'werde', 'wirst', 'wird', 'werdet', 'wurde', 'wurdest', 'wurden',
  'würde', 'würden', 'geworden', 'worden',
  // Common lexical verbs
  'machen', 'mache', 'machst', 'macht', 'machte', 'machten', 'gemacht',
  'geben', 'gebe', 'gibst', 'gibt', 'gebt', 'gab', 'gaben', 'gegeben',
  'gehen', 'gehe', 'gehst', 'geht', 'ging', 'gingen', 'gegangen',
  'kommen', 'komme', 'kommst', 'kommt', 'kam', 'kamen', 'gekommen',
  'sehen', 'sehe', 'siehst', 'sieht', 'seht', 'sah', 'sahen', 'gesehen',
  'sagen', 'sage', 'sagst', 'sagt', 'sagte', 'sagten', 'gesagt',
  'finden', 'finde', 'findest', 'findet', 'fand', 'fanden', 'gefunden',
  'nehmen', 'nehme', 'nimmst', 'nimmt', 'nehmt', 'nahm', 'nahmen', 'genommen',
  'wissen', 'weiß', 'weißt', 'wisst', 'wusste', 'wussten', 'gewusst',
  'denken', 'denke', 'denkst', 'denkt', 'dachte', 'dachten', 'gedacht',
  'glauben', 'glaube', 'glaubst', 'glaubt', 'glaubte', 'geglaubt',
  'brauchen', 'brauche', 'brauchst', 'braucht', 'brauchte', 'gebraucht',
  'bleiben', 'bleibe', 'bleibst', 'bleibt', 'blieb', 'blieben', 'geblieben',
  'lassen', 'lasse', 'lässt', 'lasst', 'ließ', 'ließen', 'gelassen',
  'stehen', 'stehe', 'stehst', 'steht', 'stand', 'standen', 'gestanden',
  'liegen', 'liege', 'liegst', 'liegt', 'lag', 'lagen', 'gelegen',
  'heißen', 'heiße', 'heißt', 'hieß', 'hießen', 'geheißen',
  'arbeiten', 'arbeite', 'arbeitest', 'arbeitet', 'arbeitete', 'gearbeitet',
  'schreiben', 'schreibe', 'schreibst', 'schreibt', 'schrieb', 'geschrieben',
  'reden', 'rede', 'redest', 'redet', 'redete', 'geredet',
  'fragen', 'frage', 'fragst', 'fragt', 'fragte', 'gefragt',
  'zeigen', 'zeige', 'zeigst', 'zeigt', 'zeigte', 'gezeigt',
  'spielen', 'spiele', 'spielst', 'spielt', 'spielte', 'gespielt',
  'bringen', 'bringe', 'bringst', 'bringt', 'brachte', 'gebracht',
  'halten', 'halte', 'hältst', 'hält', 'hielt', 'gehalten',
  'setzen', 'setze', 'setzt', 'setzte', 'gesetzt',
  'schicken', 'schicke', 'schickst', 'schickt', 'schickte', 'geschickt',
  // Common nouns
  'tag', 'woche', 'monat', 'jahr', 'stunde', 'minute', 'zeit', 'mal',
  'mensch', 'leute', 'frau', 'mann', 'kind', 'freund', 'team', 'kollege',
  'sache', 'ding', 'arbeit', 'haus', 'stadt', 'land', 'welt', 'weg', 'platz',
  'wort', 'name', 'frage', 'antwort', 'problem', 'idee', 'plan', 'projekt',
  'geld', 'preis', 'kunde', 'firma', 'büro', 'termin', 'meeting', 'notiz',
  'bericht', 'email', 'nachricht', 'datei', 'seite', 'teil', 'grund', 'art',
  'wert', 'fall', 'punkt', 'ende', 'anfang', 'beispiel', 'nummer', 'zahl',
  // Numerals
  'null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht',
  'neun', 'zehn', 'elf', 'zwölf', 'hundert', 'tausend', 'erste', 'zweite',
  'dritte', 'letzte', 'nächste', 'viel', 'viele', 'wenig', 'wenige', 'mehr',
  'meist', 'meiste', 'einige', 'mehrere',
  // Politeness + interjections
  'bitte', 'danke', 'gerne', 'gern', 'hallo', 'tschüss', 'okay', 'gut', 'gute',
  'guter', 'gutes', 'schlecht', 'schlechte', 'super', 'toll', 'klar', 'genau',
  'richtig', 'falsch', 'echt', 'ach', 'oh', 'naja', 'tja', 'hmm', 'ja', 'nein',
  'doch', 'eben', 'halt', 'mal', 'entschuldigung', 'verzeihung', 'willkommen',
  // Common adjectives
  'neu', 'neue', 'neuer', 'neues', 'neuen', 'neuem', 'alt', 'alte', 'alter',
  'altes', 'groß', 'große', 'großer', 'großes', 'klein', 'kleine', 'kleiner',
  'kleines', 'lang', 'lange', 'kurz', 'kurze', 'hoch', 'hohe', 'tief', 'tiefe',
  'schnell', 'schnelle', 'langsam', 'früh', 'frühe', 'spät', 'späte', 'leicht',
  'schwer', 'schwere', 'einfach', 'einfache', 'wichtig', 'wichtige', 'möglich',
  'mögliche', 'nötig', 'fertig', 'bereit', 'voll', 'volle', 'leer', 'leere',
  'erst', 'erste', 'erster', 'erstes', 'letzte', 'letzter', 'letztes',
  'nächste', 'nächster', 'nächstes', 'ganze', 'ganzer', 'ganzes',
  // Common rhyme-class words that collide with names
  'rund', 'bund', 'hund', 'mund', 'fund', 'stund', 'kunde', 'runde',
];

const ENGLISH: readonly string[] = [
  // Articles + determiners
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'no',
  'every', 'each', 'all', 'both', 'either', 'neither', 'such', 'which', 'what',
  'whose', 'another', 'other', 'others', 'same',
  // Pronouns
  'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself', 'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves', 'who', 'whom', 'someone',
  'somebody', 'something', 'anyone', 'anybody', 'anything', 'everyone',
  'everybody', 'everything', 'nobody', 'nothing', 'none', 'one', 'ones',
  // Prepositions
  'in', 'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up',
  'down', 'out', 'off', 'over', 'under', 'again', 'further', 'of', 'as', 'per',
  'via', 'within', 'without', 'upon', 'across', 'around', 'among', 'behind',
  'beside', 'beyond', 'near', 'toward', 'towards', 'onto',
  // Conjunctions + particles
  'and', 'or', 'but', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'whereas', 'unless', 'until', 'since', 'whether', 'if', 'when',
  'whenever', 'wherever', 'however', 'therefore', 'thus', 'hence', 'moreover',
  'besides', 'otherwise', 'instead', 'also', 'too', 'either', 'neither',
  // Modal + auxiliary verbs
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'ought', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'done',
  'cannot', "can't", "won't", "don't", "doesn't", "didn't", "isn't", "aren't",
  "wasn't", "weren't", "haven't", "hasn't", "hadn't", "wouldn't", "couldn't",
  "shouldn't", "i'm", "you're", "we're", "they're", "it's", "i've", "we've",
  // Common lexical verbs
  'make', 'makes', 'made', 'making', 'get', 'gets', 'got', 'getting', 'gotten',
  'go', 'goes', 'went', 'going', 'gone', 'come', 'comes', 'came', 'coming',
  'see', 'sees', 'saw', 'seen', 'seeing', 'say', 'says', 'said', 'saying',
  'know', 'knows', 'knew', 'known', 'knowing', 'think', 'thinks', 'thought',
  'thinking', 'take', 'takes', 'took', 'taken', 'taking', 'give', 'gives',
  'gave', 'given', 'giving', 'find', 'finds', 'found', 'finding', 'tell',
  'tells', 'told', 'telling', 'ask', 'asks', 'asked', 'asking', 'work',
  'works', 'worked', 'working', 'want', 'wants', 'wanted', 'wanting', 'need',
  'needs', 'needed', 'needing', 'use', 'uses', 'used', 'using', 'try', 'tries',
  'tried', 'trying', 'call', 'calls', 'called', 'calling', 'keep', 'keeps',
  'kept', 'keeping', 'let', 'lets', 'put', 'puts', 'putting', 'mean', 'means',
  'meant', 'show', 'shows', 'showed', 'shown', 'showing', 'send', 'sends',
  'sent', 'sending', 'run', 'runs', 'ran', 'running', 'feel', 'feels', 'felt',
  'leave', 'leaves', 'left', 'leaving', 'help', 'helps', 'helped', 'helping',
  'talk', 'talks', 'talked', 'talking', 'play', 'plays', 'played', 'playing',
  'move', 'moves', 'moved', 'moving', 'like', 'likes', 'liked', 'liking',
  'look', 'looks', 'looked', 'looking', 'seem', 'seems', 'seemed',
  // Common nouns
  'time', 'day', 'week', 'month', 'year', 'hour', 'minute', 'thing', 'things',
  'person', 'people', 'man', 'woman', 'child', 'friend', 'team', 'work',
  'home', 'house', 'place', 'world', 'way', 'word', 'name', 'question',
  'answer', 'problem', 'idea', 'plan', 'project', 'money', 'price', 'customer',
  'company', 'office', 'meeting', 'note', 'report', 'email', 'message', 'file',
  'page', 'part', 'point', 'end', 'start', 'example', 'number', 'case', 'kind',
  'fact', 'side', 'group', 'today', 'tomorrow', 'yesterday',
  // Numerals
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'hundred', 'thousand', 'first', 'second',
  'third', 'last', 'next', 'many', 'much', 'few', 'more', 'most', 'several',
  'less', 'least',
  // Adverbs
  'here', 'there', 'where', 'now', 'then', 'always', 'never', 'often',
  'sometimes', 'rarely', 'soon', 'just', 'still', 'already', 'yet', 'again',
  'very', 'quite', 'rather', 'really', 'almost', 'nearly', 'only', 'even',
  'also', 'too', 'so', 'well', 'maybe', 'perhaps', 'sure', 'surely', 'why',
  'how', 'far', 'away', 'back', 'forward', 'together', 'alone', 'not',
  // Politeness + interjections + adjectives
  'please', 'thanks', 'thank', 'hello', 'hi', 'bye', 'okay', 'ok', 'yes',
  'yeah', 'yep', 'nope', 'sorry', 'welcome', 'good', 'great', 'nice', 'fine',
  'bad', 'best', 'better', 'worse', 'worst', 'right', 'wrong', 'true', 'false',
  'new', 'old', 'big', 'small', 'large', 'little', 'long', 'short', 'high',
  'low', 'fast', 'slow', 'early', 'late', 'easy', 'hard', 'simple', 'important',
  'possible', 'ready', 'full', 'empty', 'whole', 'real', 'sure', 'clear',
  'open', 'close', 'same', 'different', 'own', 'main',
];

/**
 * Combined, deduplicated set of protected stop words (lowercase).
 * Exported for `applySessionGlossary()` and for tests.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set<string>([
  ...GERMAN.map((w) => w.toLowerCase()),
  ...ENGLISH.map((w) => w.toLowerCase()),
]);
