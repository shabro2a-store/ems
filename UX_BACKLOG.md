# UX Backlog — Items to Polish Before Production

**Status:** Captured 2026-07-24. Not yet scheduled.
**Origin:** Owner noticed UI needs polish after local testing.
**Owner:** Kyvera (me). Implementation happens after single-branch pilot.

---

## What the owner said (verbatim)

> "the download as pdf botton works. the ui need change though. the user experiance is what needs changing :P"

No specific items called out. Below is my best-guess backlog based on what I've seen during local testing. **Owner should add to / remove from this list as they test more.**

---

## My guesses (rank by likely impact)

### High priority (visible in every flow)

1. **Empty states** — when lists are empty (no users, no branches, no flags), show a helpful "what now" CTA instead of a blank page.
   - "No employees yet" + "Add your first user" button
   - "No branches yet" + "Set up your first branch" button
   - "No flags today" (just text, no action)

2. **Loading states** — replace bare "..." with skeleton loaders.
   - Admin dashboard
   - User list
   - Branch list
   - Punch list

3. **Mobile responsiveness** — admin screens were built desktop-first. Some controls crowd on a 360px phone.
   - Admin nav (could become hamburger menu)
   - Branches page (cards stack badly)
   - Punch list table (needs horizontal scroll hint)

### Medium priority (visible when something happens)

4. **Better error messages** — currently generic ("ERROR", "INVALID_INPUT"). Should be specific:
   - "GPS accuracy too low (±150m). Move near a window."
   - "Punch already recorded for 09:05 today."
   - "DB password mismatch. Check .env."

5. **Branches page: show current coords on each card** — right now you only see them after clicking Edit. Should display under the branch name.

6. **Punch page: better GPS feedback**:
   - Show accuracy live before clicking
   - Disable button if accuracy > threshold
   - Show "you are Xm from the store" when outside geofence

### Low priority (nice-to-have)

7. **Login page polish** — show "Welcome back, {username}" if cookies exist
8. **Admin nav: highlight current section** — font-bold on active link
9. **Buttons: consistent iconography** — some have 📍, some don't
10. **Theme: dark mode toggle** — out of scope for v1

---

## What I need from the owner

Tell me **specifically** which of these (or what else) matters most. Format:

```
+ add: <specific thing you saw>
- remove: <this isn't actually a problem>
priority: <high|med|low>
```

Or just describe in your own words and I'll file it.

---

## When to implement

- **After single-branch pilot** once we know what real users actually find confusing
- Not before — pilot feedback > my guesses
- Phase 7b / 7c / 7d will be created from this backlog as discrete tickets

---

## Status: NOT YET STARTED. Live locally. Working. Awaiting owner feedback.
