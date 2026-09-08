/** Quotes by time-of-day mood (31 each = no repeat within a month per slot) */
export const QUOTES: Record<string, Array<{ text: string; author: string }>> = {
	morning: [
		{ text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
		{ text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
		{ text: 'Opportunities don\'t happen. You create them.', author: 'Chris Grosser' },
		{ text: 'The way to get started is to quit talking and begin doing.', author: 'Walt Disney' },
		{ text: 'Your time is limited. Don\'t waste it living someone else\'s life.', author: 'Steve Jobs' },
		{ text: 'It always seems impossible until it\'s done.', author: 'Nelson Mandela' },
		{ text: 'Stay hungry, stay foolish.', author: 'Stewart Brand' },
		{ text: 'The best way to predict the future is to create it.', author: 'Peter Drucker' },
		{ text: 'What would you attempt to do if you knew you could not fail?', author: 'Robert Schuller' },
		{ text: 'The future belongs to those who believe in the beauty of their dreams.', author: 'Eleanor Roosevelt' },
		{ text: 'The only limit to our realization of tomorrow is our doubts of today.', author: 'Franklin D. Roosevelt' },
		{ text: 'Start where you are. Use what you have. Do what you can.', author: 'Arthur Ashe' },
		{ text: 'Believe you can and you\'re halfway there.', author: 'Theodore Roosevelt' },
		{ text: 'You miss 100% of the shots you don\'t take.', author: 'Wayne Gretzky' },
		{ text: 'In the middle of difficulty lies opportunity.', author: 'Albert Einstein' },
		{ text: 'Every expert was once a beginner.', author: 'Helen Hayes' },
		{ text: 'The only person you are destined to become is the person you decide to be.', author: 'Ralph Waldo Emerson' },
		{ text: 'Act as if what you do makes a difference. It does.', author: 'William James' },
		{ text: 'Energy and persistence conquer all things.', author: 'Benjamin Franklin' },
		{ text: 'You are never too old to set another goal or to dream a new dream.', author: 'C.S. Lewis' },
		{ text: 'The beginning is always today.', author: 'Mary Shelley' },
		{ text: 'With the new day comes new strength and new thoughts.', author: 'Eleanor Roosevelt' },
		{ text: 'Each day provides its own gifts.', author: 'Marcus Aurelius' },
		{ text: 'Nothing will work unless you do.', author: 'Maya Angelou' },
		{ text: 'You don\'t have to be great to start, but you have to start to be great.', author: 'Zig Ziglar' },
		{ text: 'Life begins at the end of your comfort zone.', author: 'Neale Donald Walsch' },
		{ text: 'The mind is everything. What you think you become.', author: 'Buddha' },
		{ text: 'Be the change you wish to see in the world.', author: 'Mahatma Gandhi' },
		{ text: 'The best time to plant a tree was 20 years ago. The second best time is now.', author: 'Chinese Proverb' },
		{ text: 'What lies behind us and what lies before us are tiny matters compared to what lies within us.', author: 'Ralph Waldo Emerson' },
		{ text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt' },
	],
	afternoon: [
		{ text: 'Vision without execution is hallucination.', author: 'Thomas Edison' },
		{ text: 'Done is better than perfect.', author: 'Sheryl Sandberg' },
		{ text: 'Move fast and make things.', author: 'Mark Zuckerberg' },
		{ text: 'First, solve the problem. Then, write the code.', author: 'John Johnson' },
		{ text: 'Ideas are easy. Implementation is hard.', author: 'Guy Kawasaki' },
		{ text: 'Make something people want.', author: 'Y Combinator' },
		{ text: 'What gets measured gets managed.', author: 'Peter Drucker' },
		{ text: 'Build something 100 people love, not something 1 million people kind of like.', author: 'Paul Graham' },
		{ text: 'Innovation distinguishes between a leader and a follower.', author: 'Steve Jobs' },
		{ text: 'If you\'re not embarrassed by the first version, you launched too late.', author: 'Reid Hoffman' },
		{ text: 'Culture eats strategy for breakfast.', author: 'Peter Drucker' },
		{ text: 'Don\'t find customers for your products. Find products for your customers.', author: 'Seth Godin' },
		{ text: 'Fall in love with the problem, not the solution.', author: 'Uri Levine' },
		{ text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
		{ text: 'Focus is saying no to the 1,000 other good ideas.', author: 'Steve Jobs' },
		{ text: 'Real artists ship.', author: 'Steve Jobs' },
		{ text: 'The most dangerous phrase is: We\'ve always done it this way.', author: 'Grace Hopper' },
		{ text: 'Talk is cheap. Show me the code.', author: 'Linus Torvalds' },
		{ text: 'Measure what matters.', author: 'John Doerr' },
		{ text: 'Well done is better than well said.', author: 'Benjamin Franklin' },
		{ text: 'The successful warrior is the average man, with laser-like focus.', author: 'Bruce Lee' },
		{ text: 'Quality means doing it right when no one is looking.', author: 'Henry Ford' },
		{ text: 'Plans are nothing; planning is everything.', author: 'Dwight D. Eisenhower' },
		{ text: 'Perfection is achieved when there is nothing left to take away.', author: 'Antoine de Saint-Exupéry' },
		{ text: 'If you can\'t explain it simply, you don\'t understand it well enough.', author: 'Albert Einstein' },
		{ text: 'The impediment to action advances action. What stands in the way becomes the way.', author: 'Marcus Aurelius' },
		{ text: 'Do not wait to strike till the iron is hot; make it hot by striking.', author: 'William Butler Yeats' },
		{ text: 'Action is the foundational key to all success.', author: 'Pablo Picasso' },
		{ text: 'It is not enough to be busy. The question is: What are we busy about?', author: 'Henry David Thoreau' },
		{ text: 'The only way to go fast is to go well.', author: 'Robert C. Martin' },
		{ text: 'Iteration beats perfection.', author: 'Tom Kelley' },
	],
	evening: [
		{ text: 'We are what we repeatedly do. Excellence is not an act, but a habit.', author: 'Aristotle' },
		{ text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
		{ text: 'The journey of a thousand miles begins with a single step.', author: 'Lao Tzu' },
		{ text: 'In the end, it\'s not the years in your life that count. It\'s the life in your years.', author: 'Abraham Lincoln' },
		{ text: 'Life is what happens when you\'re busy making other plans.', author: 'John Lennon' },
		{ text: 'Not everything that is faced can be changed, but nothing can be changed until it is faced.', author: 'James Baldwin' },
		{ text: 'It does not matter how slowly you go as long as you do not stop.', author: 'Confucius' },
		{ text: 'Turn your wounds into wisdom.', author: 'Oprah Winfrey' },
		{ text: 'Our greatest glory is not in never falling, but in rising every time we fall.', author: 'Confucius' },
		{ text: 'I have not failed. I\'ve just found 10,000 ways that won\'t work.', author: 'Thomas Edison' },
		{ text: 'Knowing yourself is the beginning of all wisdom.', author: 'Aristotle' },
		{ text: 'The only true wisdom is in knowing you know nothing.', author: 'Socrates' },
		{ text: 'Try not to become a man of success. Rather become a man of value.', author: 'Albert Einstein' },
		{ text: 'A smooth sea never made a skilled sailor.', author: 'Franklin D. Roosevelt' },
		{ text: 'Happiness depends upon ourselves.', author: 'Aristotle' },
		{ text: 'He who has a why to live for can bear almost any how.', author: 'Friedrich Nietzsche' },
		{ text: 'To improve is to change; to be perfect is to change often.', author: 'Winston Churchill' },
		{ text: 'The measure of intelligence is the ability to change.', author: 'Albert Einstein' },
		{ text: 'An unexamined life is not worth living.', author: 'Socrates' },
		{ text: 'The best way out is always through.', author: 'Robert Frost' },
		{ text: 'Everything has beauty, but not everyone sees it.', author: 'Confucius' },
		{ text: 'In three words I can sum up everything I\'ve learned about life: it goes on.', author: 'Robert Frost' },
		{ text: 'You must do the things you think you cannot do.', author: 'Eleanor Roosevelt' },
		{ text: 'Strive not to be a success, but rather to be of value.', author: 'Albert Einstein' },
		{ text: 'The purpose of life is a life of purpose.', author: 'Robert Byrne' },
		{ text: 'What we achieve inwardly will change outer reality.', author: 'Plutarch' },
		{ text: 'The only thing we have to fear is fear itself.', author: 'Franklin D. Roosevelt' },
		{ text: 'Difficulties strengthen the mind, as labor does the body.', author: 'Seneca' },
		{ text: 'The unexamined life is not worth living, but the unlived life is not worth examining.', author: 'Socrates' },
		{ text: 'What you do speaks so loudly that I cannot hear what you say.', author: 'Ralph Waldo Emerson' },
		{ text: 'The best revenge is massive success.', author: 'Frank Sinatra' },
	],
	night: [
		{ text: 'The people who are crazy enough to think they can change the world are the ones who do.', author: 'Steve Jobs' },
		{ text: 'Everything around you was built by people no smarter than you.', author: 'Steve Jobs' },
		{ text: 'Think different.', author: 'Apple' },
		{ text: 'Imagination is more important than knowledge.', author: 'Albert Einstein' },
		{ text: 'Logic will get you from A to B. Imagination will take you everywhere.', author: 'Albert Einstein' },
		{ text: 'Creativity is intelligence having fun.', author: 'Albert Einstein' },
		{ text: 'The night is darkest just before the dawn.', author: 'Thomas Fuller' },
		{ text: 'To invent, you need a good imagination and a pile of junk.', author: 'Thomas Edison' },
		{ text: 'Have no fear of perfection — you\'ll never reach it.', author: 'Salvador Dalí' },
		{ text: 'Art is never finished, only abandoned.', author: 'Leonardo da Vinci' },
		{ text: 'The chief enemy of creativity is good sense.', author: 'Pablo Picasso' },
		{ text: 'Without great solitude, no serious work is possible.', author: 'Pablo Picasso' },
		{ text: 'Sleep is the best meditation.', author: 'Dalai Lama' },
		{ text: 'The quieter you become, the more you can hear.', author: 'Ram Dass' },
		{ text: 'All truly great thoughts are conceived while walking.', author: 'Friedrich Nietzsche' },
		{ text: 'The cosmos is within us. We are made of star-stuff.', author: 'Carl Sagan' },
		{ text: 'I dream my painting and I paint my dream.', author: 'Vincent van Gogh' },
		{ text: 'There is nothing impossible to those who will try.', author: 'Alexander the Great' },
		{ text: 'Be yourself; everyone else is already taken.', author: 'Oscar Wilde' },
		{ text: 'What you seek is seeking you.', author: 'Rumi' },
		{ text: 'The only impossible journey is the one you never begin.', author: 'Tony Robbins' },
		{ text: 'Not all those who wander are lost.', author: 'J.R.R. Tolkien' },
		{ text: 'We are all in the gutter, but some of us are looking at the stars.', author: 'Oscar Wilde' },
		{ text: 'The darker the night, the brighter the stars.', author: 'Fyodor Dostoevsky' },
		{ text: 'A ship in harbor is safe, but that is not what ships are built for.', author: 'John A. Shedd' },
		{ text: 'The wound is the place where the Light enters you.', author: 'Rumi' },
		{ text: 'One day or day one. You decide.', author: 'Paulo Coelho' },
		{ text: 'In solitude the mind gains strength and learns to lean upon itself.', author: 'Laurence Sterne' },
		{ text: 'The most beautiful things cannot be seen or touched, they are felt with the heart.', author: 'Antoine de Saint-Exupéry' },
		{ text: 'Two things are infinite: the universe and human stupidity.', author: 'Albert Einstein' },
		{ text: 'Dwell on the beauty of life. Watch the stars, and see yourself running with them.', author: 'Marcus Aurelius' },
	],
};

/** Greetings by time slot (7+ each = weekly variety) */
export const GREETINGS: Record<string, Array<{ de: string; en: string; punct?: string }>> = {
	night: [
		{ de: 'Noch wach', en: 'Still up', punct: '?' },
		{ de: 'Nachtschicht', en: 'Night owl', punct: '?' },
		{ de: 'Die besten Ideen kommen nachts', en: 'The best ideas come at night' },
		{ de: 'Kannst du auch nicht schlafen', en: 'Can\'t sleep either', punct: '?' },
		{ de: 'Stille Stunden, klare Gedanken', en: 'Quiet hours, clear thoughts' },
		{ de: 'Die Welt schläft, du nicht', en: 'The world sleeps, you don\'t' },
		{ de: 'Nachts passiert die Magie', en: 'Magic happens at night' },
	],
	early: [
		{ de: 'Früh dran heute', en: 'Up early today' },
		{ de: 'Der frühe Vogel', en: 'Early bird' },
		{ de: 'Guten Morgen', en: 'Good morning' },
		{ de: 'Die Welt gehört den Frühaufstehern', en: 'The world belongs to early risers' },
		{ de: 'Frisch ans Werk', en: 'Fresh start' },
		{ de: 'Kaffee schon fertig', en: 'Coffee ready', punct: '?' },
		{ de: 'Ein neuer Tag, ein neuer Anfang', en: 'A new day, a new beginning' },
	],
	morning: [
		{ de: 'Guten Morgen', en: 'Good morning' },
		{ de: 'Bereit für Grosses', en: 'Ready for big things', punct: '?' },
		{ de: 'Auf geht\'s', en: 'Let\'s go' },
		{ de: 'Los geht\'s', en: 'Here we go' },
		{ de: 'Was steht heute an', en: 'What\'s on today', punct: '?' },
		{ de: 'Volle Kraft voraus', en: 'Full speed ahead' },
		{ de: 'Lass uns loslegen', en: 'Let\'s get started' },
	],
	lunch: [
		{ de: 'Mahlzeit', en: 'Lunchtime' },
		{ de: 'Kurze Pause', en: 'Quick break', punct: '?' },
		{ de: 'Halftime', en: 'Halftime' },
		{ de: 'Energie tanken', en: 'Recharge' },
		{ de: 'Schon halb geschafft', en: 'Halfway there' },
		{ de: 'Mittagstief? Nicht mit uns', en: 'Afternoon slump? Not with us' },
		{ de: 'Stärkung für die zweite Hälfte', en: 'Fuel for the second half' },
	],
	afternoon: [
		{ de: 'Guten Tag', en: 'Good afternoon' },
		{ de: 'Produktiver Nachmittag', en: 'Productive afternoon', punct: '?' },
		{ de: 'Endspurt', en: 'Home stretch' },
		{ de: 'Die zweite Hälfte zählt', en: 'The second half counts' },
		{ de: 'Noch was schaffen', en: 'Get more done', punct: '?' },
		{ de: 'Weiter geht\'s', en: 'Moving on' },
		{ de: 'Fast geschafft', en: 'Almost there' },
	],
	evening: [
		{ de: 'Guten Abend', en: 'Good evening' },
		{ de: 'Feierabend', en: 'After hours', punct: '?' },
		{ de: 'Schönen Abend', en: 'Nice evening' },
		{ de: 'Tag gut verbracht', en: 'Day well spent' },
		{ de: 'Zeit durchzuatmen', en: 'Time to breathe' },
		{ de: 'Noch ein letzter Gedanke', en: 'One last thought', punct: '?' },
		{ de: 'Entspannt in den Abend', en: 'Relaxed into the evening' },
	],
};

/**
 * Which quote pool an hour of the local day belongs to.
 *
 * Takes the hour as a number rather than a Date so the mapping is pure and
 * carries no timezone — a test can walk all 24 hours without pinning TZ, and
 * the boundaries are asserted rather than inferred from wherever CI happens to
 * run.
 */
export function moodForHour(hour: number): string {
	if (hour >= 5 && hour < 12) return 'morning';
	if (hour >= 12 && hour < 18) return 'afternoon';
	if (hour >= 18 && hour < 23) return 'evening';
	return 'night';
}

/** Which greeting pool an hour of the local day belongs to. Pure, see moodForHour. */
export function slotForHour(hour: number): string {
	if (hour >= 23 || hour < 5) return 'night';
	if (hour < 8) return 'early';
	if (hour < 12) return 'morning';
	if (hour < 14) return 'lunch';
	if (hour < 18) return 'afternoon';
	return 'evening';
}

/**
 * Index of the local calendar day within its year, counted from 0.
 *
 * The previous form divided an elapsed-millisecond span by a fixed 24 h
 * (`(Date.now() - new Date(year, 0, 0)) / 86_400_000`), which is not a calendar
 * day count: a DST transition shifts the whole scale, so the rollover walks off
 * midnight. Measured in Europe/Zurich on 2026-09-08, the old form still
 * returned 250 at 00:30 and first returned 251 at 01:00 — the "day" turned an
 * hour late, all summer long.
 *
 * Differencing two local midnights and rounding is DST-proof: the span between
 * them is 23 h or 25 h on a transition day, and rounding absorbs it.
 */
export function dayIndex(now: Date): number {
	const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const startOfYear = new Date(now.getFullYear(), 0, 1);
	return Math.round((startOfDay.getTime() - startOfYear.getTime()) / 86_400_000);
}

/**
 * Pick a deterministic quote for a given moment.
 *
 * `nowMs` is required and deliberately has no default. These picks are rendered
 * inside a Svelte block with no reactive dependency of its own, so a function
 * that read the clock itself froze at first render and showed the wrong slot
 * for as long as the page stayed open. Making the clock an argument means a
 * caller has to name where the time comes from, and the compiler asks.
 * The intended source is `wallClockNow()` from stores/wall-clock.svelte.ts.
 */
export function getTodaysQuote(nowMs: number): { text: string; author: string } {
	const now = new Date(nowMs);
	const pool = QUOTES[moodForHour(now.getHours())]!;
	return pool[dayIndex(now) % pool.length]!;
}

/** Pick a deterministic greeting for a given moment. `nowMs`: see getTodaysQuote. */
export function getGreeting(locale: string, nowMs: number): { text: string; punct: string } {
	const now = new Date(nowMs);
	const pool = GREETINGS[slotForHour(now.getHours())]!;
	const pick = pool[dayIndex(now) % pool.length]!;
	return { text: locale === 'de' ? pick.de : pick.en, punct: pick.punct ?? '.' };
}
