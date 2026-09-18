# Beats

Counts how many beats a second an interval is making.

Play two notes on a piano and it works out which two they are, which pair of their
partials is beating against which, and how fast. It is meant for the moment in laying a
temperament when the thirds are running at nine or thirteen a second and the ear has
stopped counting and started guessing.

That is the whole app. No cents, no tuning curve, no stretch, no opinion about how the
piano should be tuned.

## What it tells you

    F3 — A3
    major third
    5th partial against the 4th, near 874 Hz

               6.4
        beats per second

    ~~~\_/~~~\_/~~~\_/~~~\_/~~~     the beat itself, drawn

    equal temperament wants, from this F3     6.9
    this piano is sitting at           A4 ≈ 438.9 Hz
    wide of pure by                            14.9¢

The drawn trace is the amplitude of those two partials over the last second or two —
the beat, not a summary of it. If it swells in step with what you hear, the app is
counting the same thing you are. If it isn't, you can see that immediately.

**The target is arithmetic on pure strings.** Real strings are stiff and their partials
run sharp, so no real piano beats at the printed rate exactly. Which way it goes depends
on the interval, and the app says which on screen. Nothing is corrected for it —
correcting would mean measuring each string's stiffness, which is a different
instrument's job.

## When it won't give you a number

It would rather say nothing than say something it does not believe, so it declines when
the band it is listening to has more than one thing going on in it. Graded against
known rates on real recordings, every reading it committed to was within two tenths of
a beat, and every one it declined would have been out by half a beat or more.

The commonest reason is a unison that is not together — that note's own strings beat in
the same band as the interval does. It says so, because the answer is to pull the
unison in first.

Octaves have to be picked by hand rather than heard: the upper note of an octave has no
partial that the lower one does not already have, so nothing in the sound tells an
octave apart from a single note.

## Running it

Plain files. No build step, no npm, no bundler — open `index.html` from a web server
over https, which the microphone requires.

    py -3 -m http.server 8777

`check/` is the bench: synthetic intervals whose beat rate is known by construction,
and a loader for single-note recordings that get mixed into intervals so the engine can
be graded against real piano timbre. Open `check/` and it runs itself.

## The measurement

1. Find the two fundamentals in the spectrum. Nothing is snapped to a keyboard — the
   beat depends on where the strings are, not what they are called.
2. Name the interval from the ratio, and look up which partials coincide.
3. Find that coincidence in the spectrum, then follow that one narrow band through time
   by multiplying the audio against an oscillator sitting on it. This is what separates
   the interval's beat from the unisons, the sympathetic strings and the room.
4. Take the note's decay out of the band's amplitude and find the rate at which what is
   left rises and falls.
5. Check it against a second, independent method — separating the two partials in the
   spectrum and subtracting them — wherever they are far enough apart to resolve.

`dsp.js` does the signal processing, `listen.js` the chain above, `intervals.js` holds
which partials beat against which, `capture.js` is the microphone, `app.js` is the
screen.
