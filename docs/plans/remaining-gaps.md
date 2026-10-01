# Plan: the last 25 gaps

Each step is one mechanic: read its numbers from the game files, model it, add tests,
then `npm run validate && npx vitest run && npm run build`, then commit. Steps are
independent; their order follows how many picks each one closes.

| # | Step | Picks it closes | Approach |
|---|---|---|---|
| 1 | Smiting Spear concurrency | Chain Pulse, Spear Grid, Enduring Spear, Charged Spear | Spears out at once = casts/s x spear lifetime (BP numbers), up to 6. Chain Pulse: each pulse 60% to pulse every other spear. Spear Grid: 30 per enemy entering the field between stuck spears. Enduring Spear: kills (pack) reset a spear's life. Charged Spear: +50% damage and duration per stack consumed. |
| 2 | Turret extras | Ammo Transfer, Buddy System | Turret shots/s x uptime -> 60% refund one round each (stretches your clip). Buddy System: -10s cooldown, -25% damage, +25% per Turret in range (Turrets alive at once from lifetime / cooldown). |
| 3 | Area size | Raging Storm, Explosive Valve (+ radius picks now worth something: Storm Caller, Squall, Wind's Devastation, Destructive Winds' size, Seismic Fuel, Accelerating Core) | Track area-size bonuses per payload/mode; "damage scales with area size" multiplies by it. |
| 4 | Cross-aspect Frozen | Blightful Freeze | Compute Freeze first; other aspects' status damage x (1 + 15% x Frozen uptime). |
| 5 | Barrier vs enemy attacks | Dazing Barrier, Retaliating Barrier | Ideal: enemies attack you while the Barrier is up. Dazing: +15% damage taken, scaled by Barrier uptime. Retaliating: the Barrier's absorbed amount x101 reflected per activation. |
| 6 | Blood Orbs | Blood Sphere, Bloodsplosions | Orb spawn rate from Hemorrhage procs; ideal: you shoot the orb while it's up (x2 to its enemy), Bloodsplosions explodes the stored damage over an area. |
| 7 | Your missing Health | Feeble Blood, Power From Pain | Scale with the "Your health" slider (player max Health from the player Blueprint). Zero at the ideal full Health, but counted. |
| 8 | Cross-mode weapon upgrades | Automatic Detonation, Wireless Transmitter, Shortbow | Disc: Primary weakspot hits fire the Secondary's detonation. Tesla: Secondary effect durations +20% per active one. Bow: auto-release at full charge -- check whether the mode's rate already assumes it. |
| 9 | Shadow Conversion, Sanctum, Everlasting Winter, Erupting Gold | the rest | Shadow Conversion: one +100% hit per newly afflicted enemy (pack kills). Sanctum: field radius from its Blueprint. Everlasting Winter / Erupting Gold: one more search for the missing numbers; otherwise they stay honest gaps. |
| 10 | Out of scope, said so | Thawing Strike, Execution, Ocean's Embrace | Melee isn't part of the simulated rotation and the planner is solo (no allies). Mark them as such rather than as gaps. |
