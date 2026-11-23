export const AUTHENTIC_TDT_ACTIONS_LIST =
  'At Rest, Flip Letters, Spin Letters, Cartwheel Letters, Side to Side, Rock, Back and Forth, Grow and Shrink, Flip, Spin, Cartwheel, The Wave, Hide and Appear, Walk Forward*, Hop, Stretch';

export const MODEL_FALLBACK_CHAIN: { model: string; thinkingLevel?: 'MINIMAL' | 'LOW' }[] = [
  { model: 'gemini-3.1-flash-lite', thinkingLevel: 'MINIMAL' },
  { model: 'gemini-4-hydrogen', thinkingLevel: 'LOW' },
  { model: 'gemini-3.5-flash-lite' },
  { model: 'gemini-2.5-flash' },
];

export interface CatalogSummaryPayload {
  scenes: { name: string; viewCount: number }[];
  actors: (string | { name: string })[];
  commonActorActions?: string[];
  props: (string | { name: string })[];
  commonPropActions?: string[];
  specialPropActions?: Record<string, string[]>;
  tdtFonts: string[];
  tdtShapes: string[];
  tdtActions?: string[];
  fonts2d?: string[];
  transitions?: string[];
  sounds: {
    name: string;
    category: 'sfx' | 'music' | 'speech';
    sourceLabel?: string;
    isMidi?: boolean;
  }[];
}

const NUMBER_WORD_MAP: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

export function extractRequestedSceneCount(prompt: string): number | null {
  if (!prompt) return null;
  const digitMatch =
    prompt.match(
      /\b(?:with|make|create|generate|have|build|at\s+least|exactly)?\s*(\d{1,2})\s*[- ]?\s*scenes?\b/i
    ) || prompt.match(/\bscenes?\s*[:=]\s*(\d{1,2})\b/i);
  if (digitMatch) {
    const n = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(n) && n >= 1) {
      return Math.min(20, n);
    }
  }

  const wordPattern = new RegExp(
    `\\b(${Object.keys(NUMBER_WORD_MAP).join('|')})\\s*[- ]?\\s*scenes?\\b`,
    'i'
  );
  const wordMatch = prompt.match(wordPattern);
  if (wordMatch) {
    const n = NUMBER_WORD_MAP[wordMatch[1].toLowerCase()];
    if (n) return n;
  }
  return null;
}

export function extractRequestedActorCount(prompt: string): number | null {
  if (!prompt) return null;
  const digitMatch =
    prompt.match(
      /\b(?:with|at\s+least|cast\s+of|put|have)?\s*(\d{1,2})\s*[- ]?\s*(?:actors?|characters?|people|kids|heroes|villains)\b/i
    ) || prompt.match(/\bactors?\s*[:=]\s*(\d{1,2})\b/i);
  if (digitMatch) {
    const n = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(n) && n >= 1) {
      return Math.min(12, n);
    }
  }

  const wordPattern = new RegExp(
    `\\b(${Object.keys(NUMBER_WORD_MAP).join('|')})\\s*[- ]?\\s*(?:actors?|characters?|people|kids)\\b`,
    'i'
  );
  const wordMatch = prompt.match(wordPattern);
  if (wordMatch) {
    const n = NUMBER_WORD_MAP[wordMatch[1].toLowerCase()];
    if (n) return Math.min(12, n);
  }
  return null;
}

export const STATIC_3MM_CHOREOGRAPHY_EXEMPLARS = `
DISTILLED 45-FILM .3MM CORPUS EXEMPLARS:
- "Asylum" [3dmmstudio, 17 scenes, rating=9/10]: arc=HH-Interior -> HH-Foyer -> HH-Lab -> AD-Cave -> GE-Black(viewIndex=0/3), fast 16-24f cuts, multi-actor confrontations (4-5 actors in group scenes), sudden Spin/Faint reactions, late prop reveals via frame timing.
- "Domicile Destructo's Nightmare" [3dmmstudio, 12 scenes, rating=8.5/10]: multi-location comedy horror, stretched/squashed Cube/Torus/Sphere props as custom haunted traps & surreal rooms inside GE-Black, bright tinted Explosio blasts synced with explosion WAVs, Walk Fast -> Run Scared -> Fall choreography.
- "The Thief" / "THEBOOK.3MM" / "HOSPITAL.3MM" [classic & community .3mm]: tight dialogue voice cues synced with Mouth/Talk/Sit/Yell beats + non-overlapping 2D captions + closing slow credits, expressive costume variations per character.
- "Space" / "Venus 31" [3dmmstudio sci-fi]: GE-Black viewIndex=3 (Starfield in space) with colored Spheres (planets/moons), tilted scaled Torus (planetary rings & portals), stretched Cubes (spaceship hull/laser beams), Rocket (Fly), UFO/Alien actors, custom sci-fi voice/static SFX & Studio .MID soundtrack.`;

export const CORE_3DMM_TRAINING_GUIDE = `You are a master Microsoft 3D Movie Maker director trained on a 45-film .3mm corpus (604 scenes across classic 3DMM sample movies + acclaimed 3dmmstudio.co.uk hits like Asylum, Lord of the Flies, Domicile Destructo's Nightmare, Venus 31, The Thief, Sprog, The Book, Hospital, Terror at McZee Manor).
Emit clean, tight, valid JSON matching the schema—never waste filler duplicate keyframes when an actor is stationary, and keep choreography readable, expressive, and cinematic!

CORPUS-DISTILLED 3DMM DIRECTION RULES (6 FPS: 6 frames = 1 second; median scene = 46f, median cut = 18f):
1. MULTI-SCENE STORYTELLING & FLEXIBLE SCENE LENGTHS:
   - Default to 5–8 distinct scenes covering setup, travel/escalation, complication/twist, climax, and resolution/credits—NEVER stop at just 2–3 scenes!
   - If the user asks for N scenes, produce AT LEAST N distinct scenes (exact N). Keep multi-scene entries focused so all requested scenes fit cleanly.
   - Use varied scene lengths (durationFrames): short snappy comedic beats or stingers (18–30 frames = 3–5s), standard dialogue/action scenes (42–72 frames = 7–12s), or long elaborate setpieces/battles/montages (84–180 frames = 14–30s) when the story warrants it.
   - Set scene transition per scene: "cut" (instant punchy cut), "dissolve" (smooth cross-fade), "fadeToBlack" (fade out through black for time skips/night/endings), or "fadeToWhite" (bright flash transition for explosions, rockets, magic, dreams).

2. CAMERA CUTS & SPECIAL "GE-Black" BACKGROUND ANGLES:
   - Include frame 0 plus 1–4 intentional camera cuts per scene (~14–28 frames apart; strictly 0 <= viewIndex < scene.viewCount).
   - CRITICAL CAMERA GUIDE FOR "GE-Black" (the 4-environment blank stage):
     * viewIndex 0 = Solid BLACK background (use for dark rooms, haunted voids, theater spotlights, dramatic reveals, interior night sets)
     * viewIndex 1 = Solid WHITE background (use for bright white studios, laboratories, clouds/heaven, minimalist comedy, clean custom interiors)
     * viewIndex 2 = Bright BLUE SKY background (use for flying heroes, airplanes, rockets taking off, rooftop stunts, floating cities)
     * viewIndex 3 = STARFIELD IN SPACE background (use for outer space, spaceships, planets, moons, aliens, UFO chases, asteroid fields!)

3. BIGGER CASTS, COSTUMES, FACING & ANTI-SNAIL MOVEMENT SPEED (CRITICAL):
   - Do NOT limit every scene to only 1–2 actors! When a story features crowds, families, teams, orchestras, classrooms, villains+minions, alien invasions, or party/battle scenes, place 3–8+ distinct actors (or repeated extras with different costumePreset values).
   - Set costumePreset (integer 0, 1, 2, 3, 4...) on actors & props so different characters wear distinct authentic 3DMM outfits/colors/skins. You may also set colorHex ("#rrggbb") to tint actors or shapes.
   - NO SNAIL MOVEMENTS (6 FPS SPEED MATH — CRITICAL!):
     * Playback is 6 frames per second (6f = 1 sec, 12f = 2 sec) across a ~30-unit wide stage.
     * NEVER smear one move or bounce across frame 0 -> durationFrames (e.g. f=0..48 or f=0..60 makes objects creep like snails at 0.1–0.4 units/frame!).
     * Walk / Patrol: 1.2–1.8 units/frame (cross 10–18 units in 7–14 frames, then switch to At Rest/Talk/React!).
     * Run / Chase / Speeding Car / Rocket Launch / Laser / Projectile: 2.2–4.5 units/frame (zip 18–30 units across stage or sky in 6–12 frames = 1–2 seconds!).
     * Bounces / Hops: 3–4 frames up + 3–4 frames down (repeat cycles if multiple bounces are needed — NEVER 30f up + 30f down!).
     * Only use slow speeds (< 0.7 units/frame) when the prompt explicitly calls for slow/snail/creep motion or Sneak / Crawl / Walk Slowly.
   - Stage Coordinates & Facing: Keep main action readable (x in [-10, 10], y in [0, 6], z in [-7, 9]; custom walls/planets/vehicles can span x in [-18, 18], y in [-2, 14], z in [-18, 16]). Facing: rotY = 0 faces camera, +1.57 faces right, -1.57 faces left, 3.14 faces away.
   - Sync actionSegments with movement keyframes: moving between two points MUST pair with Walk Fast / Walk Slowly / Sneak / Run / Run Scared / Fly / Crawl, and switch cleanly to At Rest / Greet / Talk / Sit, Talk, Stand / Jump / Karate Kick / Laugh / Dance / Faint / Fall / Yell / Think / Mad, Sad when arriving!

4. FRAME TIMING, APPEARANCES & DISAPPEARANCES (startFrame / endFrame / visible):
   - Use startFrame & endFrame on actors, props, tdtTexts, and textBoxes so objects enter mid-scene or vanish on cue!
   - You can ALSO toggle keyframes[].visible = false / true at specific frames for dramatic pop-ins, teleportation, hiding inside coffins/safes/chests, or timing Explosio bursts (e.g. visible:false at f=0, visible:true during impact f=24..34, visible:false at f=35).

5. COLORS, NON-UNIFORM STRETCH/SQUASH & CUSTOM ROOMS / SETS / OBJECTS:
   - You can change the color of Torus, Cube, Sphere, Explosion (Explosio), Cylinder (and any prop/actor) using colorHex ("#rrggbb") on the prop or on individual keyframes (even changing color mid-scene!).
   - You can stretch or squash ANY prop, actor, or 3D word to any proportions via keyframe scaleX, scaleY, scaleZ (0.15 to 7.0) and tilt them with rotX, rotY, rotZ (radians)!
   - CUSTOM SCENE / ROOM / OBJECT BUILDING: Whenever asked to create a custom room, house, furniture, castle, spaceship bridge, obstacle course, solar system, giant robot, or surreal set—use "GE-Black" (selecting the right viewIndex: 0=Black, 1=White, 2=Sky, 3=Starfield) OR build directly in any set using creative combinations of:
     * Cube (stretched flat for floors/rugs/ceilings/tables/beds/screens; tall & thin for walls/doors/buildings/shelves)
     * Cylinder (tall & thin for pillars/legs/trees/pipes/lasers; wide & flat for stools/pads/drums)
     * Sphere (planets/moons/lamps/domes/snowmen/boulders/heads/bushes)
     * Torus (rings around planets, hoops, tires, portals, wreaths, halos, tables)
     * Explosio (fire, sparks, plasma blasts, magic puffs with bright colorHex & Bang!/Grow Fast action)
     * tdtTexts (3D signs, neon labels, architectural sculptures, giant floating letters!)
   - Combine multiple stretched/rotated/colored primitives cleanly with distinct positions so they form cohesive rooms, vehicles, landscapes, or sculptures without clipping unintentionally into the camera.

6. AUTHENTIC 3D WORDS (tdtTexts) & STYLED 2D TEXT BOXES (textBoxes):
   - For tdtTexts[].action ONLY use exact authentic Microsoft 3DMM actions: ${AUTHENTIC_TDT_ACTIONS_LIST}. NEVER invent fake actions like bounce, wobble, float, or pulse.
   - For textBoxes, set fontName (e.g. "Comic Sans MS", "Futura", "Impact", "Times New Roman", "Courier New", "Arial"), crisp high-contrast colorHex, optional bgColorHex, placement ("top", "bottom", "center", or "credits"), and isScrolling (false for Stationary titles/dialogue captions, true for Credits scrolling). Keep captions non-overlapping.

7. CUSTOM SOUND EFFECTS, CUSTOM VOICES (.3MM) & CUSTOM STUDIO MIDI (.MID):
   - Use ONLY exact names from catalogSummary.sounds.
   - catalogSummary.sounds includes custom MIDI tracks (e.g. *.MID like BAKSTAGE.MID, BOOTHJAM.MID, CLOSET.MID, COASTER.MID, FADER.MID, IDEAS.MID, JAMLOOP.MID, LOBBY.MID, PROJECT.MID, SNACK.MID, SPLASH.MID, STUDIO.MID, TAG.MID, THEATER.MID), custom .3MM voices & SFX (marked with .3MM sourceLabel or speech/sfx), AND standard 3DMM SFX/speech/music.
   - Layer 1 music track at frame 0 (loop: true) plus 1–4 well-timed SFX & voice lines synced to physical impacts, entrances, dialogue, and comedy beats!

STRICT RULE: Only use exact scene names, actor names, prop names, action names, font/shape names, TDT action names, and sound names present in catalogSummary.`;

export function buildSystemInstruction(options: {
  prompt: string;
  requestedSceneCount: number | null;
  requestedActorCount: number | null;
  corpusExemplars?: string;
}): string {
  const { requestedSceneCount, requestedActorCount, corpusExemplars } = options;
  const sceneConstraintNote =
    requestedSceneCount !== null
      ? `\n\nMANDATORY SCENE COUNT: The user explicitly asked for ${requestedSceneCount} scenes. Your JSON output MUST contain at least ${requestedSceneCount} (target exact ${requestedSceneCount}) distinct scenes in "scenes". Never merge scenes below ${requestedSceneCount}.`
      : `\n\nMULTI-SCENE TARGET: Generate 5 to 8 rich, distinct scenes with varied locations/transitions so the story feels complete (never stop at 2–3 scenes).`;

  const actorConstraintNote =
    requestedActorCount !== null
      ? `\nMANDATORY CAST SIZE: Include at least ${requestedActorCount} actors where requested, using distinct actors or varied costumePreset values.`
      : '';

  const exemplarBlock =
    corpusExemplars && corpusExemplars.trim().length > 0
      ? corpusExemplars
      : STATIC_3MM_CHOREOGRAPHY_EXEMPLARS;

  return `${CORE_3DMM_TRAINING_GUIDE}\n${exemplarBlock}${sceneConstraintNote}${actorConstraintNote}`;
}

/**
 * OpenAPI-compatible Gemini JSON schema (never uses unsupported `minItems`).
 */
export function buildGeminiMoviePlanSchema(requestedSceneCount: number | null) {
  const sceneDesc =
    requestedSceneCount !== null
      ? `MUST contain at least ${requestedSceneCount} distinct scenes in story order (${requestedSceneCount} scenes requested). Never merge or drop scenes below ${requestedSceneCount}.`
      : '5 to 8 distinct scenes in story order covering setup, progression across sets, complication/twist, climax, and ending/credits. Never stop at only 2-3 scenes.';

  const keyframeItemSchema = {
    type: 'OBJECT',
    properties: {
      frame: {
        type: 'INTEGER',
        description: 'Frame index at 6 FPS (6f = 1s). For crisp non-snail moves across stage, space move start->end 5-16 frames apart (~1.2-3.5 units/frame), not 0->60f.',
      },
      x: { type: 'NUMBER' },
      y: { type: 'NUMBER' },
      z: { type: 'NUMBER' },
      rotX: { type: 'NUMBER', description: 'Optional tilt/pitch rotation in radians.' },
      rotY: { type: 'NUMBER', description: 'Yaw rotation in radians (0=camera, 1.57=right, -1.57=left, 3.14=away).' },
      rotZ: { type: 'NUMBER', description: 'Optional roll rotation in radians.' },
      scale: { type: 'NUMBER', description: 'Optional uniform scale multiplier (0.15 to 7.0).' },
      scaleX: { type: 'NUMBER', description: 'Optional non-uniform width stretch/squash (0.15 to 7.0).' },
      scaleY: { type: 'NUMBER', description: 'Optional non-uniform height stretch/squash (0.15 to 7.0).' },
      scaleZ: { type: 'NUMBER', description: 'Optional non-uniform depth stretch/squash (0.15 to 7.0).' },
      visible: { type: 'BOOLEAN', description: 'Set false to hide or vanish at this frame, true to appear.' },
      colorHex: { type: 'STRING', description: 'Optional per-keyframe #rrggbb tint override.' },
    },
    required: ['frame', 'x', 'y', 'z', 'rotY'],
  };

  return {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      plot: {
        type: 'STRING',
        description: 'Cohesive 2-4 sentence plot summary covering beginning, twist, and ending.',
      },
      scenes: {
        type: 'ARRAY',
        description: sceneDesc,
        items: {
          type: 'OBJECT',
          properties: {
            sceneName: { type: 'STRING' },
            durationFrames: {
              type: 'INTEGER',
              description: 'Scene length in frames at 6 FPS (short 18-30f, normal 42-72f, long 84-180f).',
            },
            transition: {
              type: 'STRING',
              description: 'Scene transition into/at this scene: cut, dissolve, fadeToBlack, or fadeToWhite.',
            },
            cameraCuts: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  frame: { type: 'INTEGER' },
                  viewIndex: { type: 'INTEGER' },
                },
                required: ['frame', 'viewIndex'],
              },
            },
            actors: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  costumePreset: {
                    type: 'INTEGER',
                    description: 'Optional costume variant index (0, 1, 2, 3...) from TMPL costume sets.',
                  },
                  colorHex: { type: 'STRING', description: 'Optional #rrggbb color tint.' },
                  startFrame: { type: 'INTEGER', description: 'Optional frame when actor enters stage (hidden before).' },
                  endFrame: { type: 'INTEGER', description: 'Optional frame when actor exits/vanishes from stage.' },
                  actionSegments: {
                    type: 'ARRAY',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        frame: { type: 'INTEGER' },
                        actionName: { type: 'STRING' },
                      },
                      required: ['frame', 'actionName'],
                    },
                  },
                  keyframes: {
                    type: 'ARRAY',
                    items: keyframeItemSchema,
                  },
                },
                required: ['name', 'actionSegments', 'keyframes'],
              },
            },
            props: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  costumePreset: {
                    type: 'INTEGER',
                    description: 'Optional prop texture/costume variant index (0, 1, 2...).',
                  },
                  colorHex: {
                    type: 'STRING',
                    description: 'Solid #rrggbb color for Torus, Cube, Sphere, Cylinder, Explosio, or any prop.',
                  },
                  startFrame: { type: 'INTEGER', description: 'Optional frame when prop appears (hidden before).' },
                  endFrame: { type: 'INTEGER', description: 'Optional frame when prop disappears.' },
                  actionSegments: {
                    type: 'ARRAY',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        frame: { type: 'INTEGER' },
                        actionName: { type: 'STRING' },
                      },
                      required: ['frame', 'actionName'],
                    },
                  },
                  keyframes: {
                    type: 'ARRAY',
                    items: keyframeItemSchema,
                  },
                },
                required: ['name', 'actionSegments', 'keyframes'],
              },
            },
            tdtTexts: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  text: { type: 'STRING' },
                  fontName: { type: 'STRING' },
                  shapeName: { type: 'STRING' },
                  action: { type: 'STRING' },
                  colorHex: { type: 'STRING' },
                  startFrame: { type: 'INTEGER' },
                  endFrame: { type: 'INTEGER' },
                  x: { type: 'NUMBER' },
                  y: { type: 'NUMBER' },
                  z: { type: 'NUMBER' },
                  rotX: { type: 'NUMBER' },
                  rotY: { type: 'NUMBER' },
                  rotZ: { type: 'NUMBER' },
                  scale: { type: 'NUMBER' },
                  scaleX: { type: 'NUMBER' },
                  scaleY: { type: 'NUMBER' },
                  scaleZ: { type: 'NUMBER' },
                  keyframes: {
                    type: 'ARRAY',
                    description: 'Optional movement keyframes for flying/moving 3D words.',
                    items: keyframeItemSchema,
                  },
                },
                required: ['text', 'fontName', 'shapeName', 'x', 'y', 'z'],
              },
            },
            textBoxes: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  text: { type: 'STRING' },
                  fontName: { type: 'STRING' },
                  fontSize: { type: 'INTEGER' },
                  startFrame: { type: 'INTEGER' },
                  endFrame: { type: 'INTEGER' },
                  placement: { type: 'STRING' },
                  isScrolling: { type: 'BOOLEAN' },
                  colorHex: { type: 'STRING' },
                  bgColorHex: { type: 'STRING' },
                },
                required: ['text', 'startFrame', 'endFrame', 'placement', 'isScrolling'],
              },
            },
            audioCues: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  frame: { type: 'INTEGER' },
                  soundName: { type: 'STRING' },
                  loop: { type: 'BOOLEAN' },
                },
                required: ['frame', 'soundName'],
              },
            },
          },
          required: ['sceneName', 'durationFrames', 'cameraCuts', 'actors', 'props'],
        },
      },
    },
    required: ['title', 'plot', 'scenes'],
  };
}
