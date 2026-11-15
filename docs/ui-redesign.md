# UI redesign spec (branch `ui/redesign`)

Source designs: the "Marswalk UI Wireframes" canvas (wireframe row + mockup row). Function follows Google Maps
(search/go-to, layer toggles, route with stops, place card per stop, live position); the look is our own.

## Rules

- **The sim, data loading and replan logic do not change.** `sim.js`, `util.js` and the tests stay as they are.
  `node --test web/tests` must still pass.
- New views only **read** state and use the existing events (`replan:confirm`, `map:focus`, `toast`).
- Every existing control keeps its element id, so `app.js` wiring keeps working.

## Visual system

| Token | Value | Use |
| --- | --- | --- |
| background | `#12100e` | page, panels (92–96% opaque over the map) |
| line | `#3a322b` | 1 px panel borders, dividers |
| text / dim | `#f4ede4` / `#b9aea2` | body / labels |
| signal (teal) | `#5eead4` | the planned route, primary buttons, active tab, stops |
| warn / danger / ok | `#ffb547` / `#ff5a4f` / `#7ee787` | alerts and status |
| fonts | Sora (UI), IBM Plex Mono (numbers, uppercase micro-labels) | Google Fonts, system fallbacks |
| shape | square panels, 2–4 px radius, no drop-shadow pills | |
| map | HiRISE tinted rust (CSS filter on the basemap only) + 100 m survey grid registered to the map | |
| stops | diamonds with a mono letter | |

## Views (top bar tabs)

| Tab | Mode | Built from |
| --- | --- | --- |
| Planner | `planner` | existing map + side panel, restyled |
| Astronaut tablet | `tablet` | **new** `tablet.js` / `tablet.css` (mockups: Tablet, Tablet replan, Tablet link lost) |
| Helmet HUD | `hud` | existing `hud.js`, restyled |
| Rover | `rover` | **new** `rover.js` / `rover.css` (mockup: Rover view) |

**DEMO ▸** opens a drawer holding the presenter controls that used to fill the top bar: Play, speed, Reset, scrubber,
budget, and the scenario toggles (slow pace, cut rover link, high air use, storm, rock field), each with one line
saying what it does. The clock and status chip stay in the bar. Play also stays in the bar.

## Astronaut tablet (touch, gloves)

- Status strip: EV1, rover link, buddy distance, env text, plan label.
- Left: **next stop** (arrow, distance, name, ETA); **air left** with bar and **time home** + margin; status card
  (what the crew is doing, rover ahead, hazard).
- Right: live map (HiRISE crop following EV1): active route, trail, stops, both crew, rover, proposed path, way home.
- Bottom: four ≥ 64 px buttons: Mark hazard, Take photo (both log a toast; demo), Pause/Resume, Way home (shows the
  saved route home on the map).
- **Replan** (`sim.pendingReplan`): full-screen card: what changed, the suggested route, why it is safe, saves N min,
  options that did not fit, **Accept new route** (emits `replan:confirm`).
- **Link lost** (`!sim.link.ok`): red banner, left card becomes "Way home" (distance, time home), map shows the
  uncertainty ring and the home path.
- **Storm**: red banner; the return proposal uses the replan card.

## Rover view

- Camera panel: a Perseverance image from near the rover's position, labeled **DEMO FRAME** (no live camera). When the
  rock-field hazard is confirmed (`sim.hazard`), a hazard box and label appear.
- Mini map centered on the rover: route, crew, hazard ring.
- Cards: localization (design target, ASSUMPTION), crew tracking (distance rover → EV1/EV2 and uncertainty from
  `sim.crew`), link status, reroute proposal (`sim.pendingReplan` with trigger `hazard`), battery/tubes are not in the
  data, so they are not shown.
- Event log from `sim.alerts`.

## Deep links (demo + testing)

`?mode=planner|tablet|hud|rover`, `?t=<min>` (seek after load), `?fault=link,air,storm,hazard`, `?slow=1`, plus the
existing `?budget=demo`, `?variant=`, `?data=`.

## Done when

- All four views render on real data at 1440×900 and 1024×768, checked by headless screenshots.
- Replan, link-lost and storm states render in the tablet; hazard in the rover view.
- `node --test web/tests` passes; no console errors on load.

## Revision 2: match every mockup screen (branch `ui/match-mockups`)

Revision 1 only restyled the existing planner, stop card and HUD. Revision 2 rebuilds them to the mockups:

| Screen | Now |
| --- | --- |
| Planner | Full-bleed map framed on the route; **layer rail** (left), **GO TO** search, legend of active layers, **route sheet** (right): stats, stop timeline, CUTS/AVOIDS lines, backup route, START EVA, safety strip, "Mission details" (the old safety / environment / alerts / credits cards) |
| Stop preview | **Dossier** in the sheet: photo grid + mosaic strip, km / arrive / work / time home, what to expect, rock unit, minerals, tube list at B, Show on map / Skip stop |
| Helmet HUD | **Visor** over a Perseverance photo near the crew: heading tape, one arrow relative to travel, distance + stop + ETA, air and time-home rings, one alert chip, reroute confirm card (Enter) |
| Demo menu | **Centered console**: switch view (incl. stop preview, EV1/EV2 tablet), sim clock with speed buttons and stop markers, budget, scenarios with RUN → (jumps to the view that shows the effect), reset |
| Tablet | + crew switch, map zoom, link-lost button set (Start walking home / Wait for link / I see a landmark) |
| Rover | + speed and tubes-loaded card (both derived from the sim) |

**Nov 14 update 2:** the DEMO console is gone; Play runs the one demo scenario (rover spots a rock field → detour → Accept). The astronaut tablet was remodeled to the planner's look (full-bleed map, floating panels).

**Nov 14 update:** the helmet HUD and rover views were removed from the app (tabs, console cards, `hud.js`/`hud.css`, `rover.js`/`rover.css`). The rock-field scenario now shows its detour on the tablet.

Not in the data, so not shown: rover battery (mockup placeholder), "Keep plan" on the reroute card (the sim has
no reject event), rock-unit search in GO TO (no unit locations in the web data).
