export const AUTHENTIC_TDT_ACTIONS_LIST =
  'At Rest, Flip Letters, Spin Letters, Cartwheel Letters, Side to Side, Rock, Back and Forth, Grow and Shrink, Flip, Spin, Cartwheel, The Wave, Hide and Appear, Walk Forward*, Hop, Stretch';

export const MODEL_FALLBACK_CHAIN: { model: string; thinkingLevel?: 'MINIMAL' | 'LOW' }[] = [
  { model: 'gemini-3.1-flash-lite', thinkingLevel: 'MINIMAL' },
  { model: 'gemini-4-hydrogen', thinkingLevel: 'LOW' },
  { model: 'gemini-4-hydrogen' },
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
- "Space" / "Venus 31" [3dmmstudio sci-fi]: GE-Black viewIndex=3 (Starfield in space) with colored Spheres (planets/moons), tilted scaled Torus (planetary rings & portals), stretched Cubes (spaceship hull/laser beams), Rocket (Fly), UFO/Alien actors, and custom sci-fi voice/static SFX & SNDS.3CN MIDI soundtrack.`;

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

3. BIGGER CASTS, COSTUMES & VARIED CHOREOGRAPHY (ANTI-REPETITION — CRITICAL!):
   - Do NOT limit every scene to only 1–2 actors! When a story features crowds, families, teams, orchestras, classrooms, villains+minions, alien invasions, or party/battle scenes, place 3–8+ distinct actors (or repeated extras with different costumePreset values).
   - Set costumePreset (integer 0, 1, 2, 3, 4...) on actors & props so characters wear distinct authentic 3DMM outfits/skins/textures. (Do NOT put colorHex on actors or regular props — ONLY Torus, Cube, Sphere, Cylinder, Explosio props and 3D/2D text accept custom colorHex!).
   - BAN HORIZONTAL LEFT-TO-RIGHT REPETITION & MATCH MOVEMENTS TO PATHS:
     * NEVER make actors repeatedly do the same horizontal left-to-right walk (x: -10 -> +10, z: 0) across scenes!
     * Vary blocking in EVERY scene across true 3D space (changing BOTH X and Z, or Z-depth, or Y-altitude):
       1) Depth Approaches Back-to-Front (x:-2, z:-10 -> x:0, z:+4, rotY: 0) & Background Exits (x:+1, z:+3 -> x:+3, z:-11, rotY: 3.14)
       2) Diagonal Crosses (x:+8, z:-6 -> x:-5, z:+5, rotY: -0.87)
       3) Right-to-Left (x:+9, z:+2 -> x:-6, z:-2, rotY: -1.82)
       4) Dialogue Pairs already stationed or arriving facing EACH OTHER (Actor A at x:-4, rotY:+1.35..+1.57 talking to Actor B at x:+4, rotY:-1.35..-1.57)
       5) Vertical / Specialty paths (Fly when moving in y > 1.2, Run Scared / Run for chases, Sneak / Crawl for stealth approaches, Walk Backwards when backing away while looking forward, Jump hops)
     * Pick actions specifically matching where & how they go: flying through air -> Fly; chasing/fleeing -> Run/Run Scared; stealth -> Sneak/Crawl; backing away -> Walk Backwards; stopping at arrival -> switch IMMEDIATELY to "At Rest" (or "Talk" / "Sit, Talk, Stand" / "Laugh" / "Yell")!
   - EXACT KEYFRAME <-> ACTION SEGMENT SYNC & CLEAN STOPS (6 FPS: 6f = 1s):
     * NEVER smear a move across frame 0 -> durationFrames! Move at crisp speed: Walk = 1.2–1.8 units/frame (6–14f), Run/Chase = 2.2–4.5 units/frame (5–11f).
     * LOCK actionSegments frames to keyframes: start locomotion at move start frame fA, keep it running continuously until fB, and ALWAYS add { frame: fB, actionName: "At Rest" } (or a stationary expressive action) at the EXACT arrival frame fB whenever the actor stops moving — NEVER leave Walk/Run active after fB!
     * Always set rotY = atan2(dx, dz) on BOTH start keyframe fA and arrival keyframe fB (only opposite for Walk Backwards).
   - Stage Coordinates & Facing: Main action in x:[-10,10], y:[0,6], z:[-7,9]; custom builds in x:[-18,18], y:[-2,14], z:[-18,16]. Facing: rotY=0 camera, +1.57 right, -1.57 left, 3.14 away, atan2(dx,dz) for diagonals.

4. FRAME TIMING, APPEARANCES & DISAPPEARANCES (startFrame / endFrame / visible):
   - Use startFrame & endFrame on actors, props, tdtTexts, and textBoxes so objects enter mid-scene or vanish on cue!
   - You can ALSO toggle keyframes[].visible = false / true at specific frames for dramatic pop-ins, teleportation, hiding inside coffins/safes/chests, or timing Explosio bursts (e.g. visible:false at f=0, visible:true during impact f=24..34, visible:false at f=35).

5. COLORS (SHAPES + EXPLOSIO + TEXT ONLY), EXACT PRIMITIVE GEOMETRY & CUSTOM SCENERY / PROPS:
   - You can change the color of Torus, Cube, Sphere, Explosion (Explosio), Cylinder props (plus tdtTexts and textBoxes) using colorHex ("#rrggbb") — even animating colors across keyframes! Do NOT tint actors or non-shape props (Car, Safe, Tent, etc.) with colorHex; use costumePreset for those.
   - Non-uniform stretch & tilt: scaleX, scaleY, scaleZ (0.04 to 10.0) and rotX, rotY, rotZ (radians) on ANY prop, actor, or 3D word!
   - EXACT 3DMM PRIMITIVE DIMENSIONS (measured from TMPLS.3CN — compute exact joins!):
     * Cube: 5x5x5 raw units centered at origin (extends +/-2.5 * scale). Sitting flat on y=0 requires center y = 2.5 * scaleY. Slab height = 5 * scaleY; width = 5 * scaleX; depth = 5 * scaleZ.
     * Sphere: 6x6x6 raw diameter (radius 3.0 * scale) centered at origin. Resting on y=0 requires center y = 3.0 * scaleY.
     * Cylinder: radius 1.0 (diameter 2 * scaleX/scaleZ), height 5.0 * scaleY vertical along Y, centered at origin. Standing on y=0 -> y = 2.5 * scaleY. Horizontal beam along X -> rotZ = 1.57; horizontal barrel/pipe along Z -> rotX = 1.57.
     * Torus: upright ring in XY plane (major radius 7.0 * scale, outer diameter 14, tube 4). Laying flat horizontally (amphitheater tiers, round tables, halos, planetary rings, tires on floor) MUST use rotX = 1.57! Upright Arch/Portal -> leave rotX = 0.
     * Explosio: HUGE raw spiky mesh (~80x80x80). Use small scale (0.06 to 0.22) for sparks/torch flames/muzzle flashes; 0.45 to 1.0 for blasts; hide until burst (visible:false -> true).
     * tdtTexts: centered horizontally, faces +Z at rotY=0, letter height ~5.0 * scaleY. Use tiny scale (0.08 to 0.22) for monitor screens, buttons, signage, forum post headers; place +0.18 to +0.35 forward in Z from a backing Cube so text never Z-fights! Use 0.4 to 0.9 for large banners.
   - CUSTOM BUILD RULE — LOCK STATIC PARTS: Every structural primitive & static 3D sign in a custom prop or custom scenery MUST use actionSegments: [{ frame: 0, actionName: "At Rest" }] and exact static coordinates so parts align flush without spinning or drifting!
   - MULTI-PART CUSTOM SCENERY & PROP BLUEPRINTS (build cohesive 5–12+ part assemblies!):
     * CUSTOM COMPUTER OBJECT (assembled desk + workstation + glowing 3D screen):
       - Desk top: Cube #92400e or #475569 (scaleX:1.8, scaleY:0.08, scaleZ:0.9, y:2.0) + 2–4 Cylinder legs (scaleX:0.14, scaleY:0.40, scaleZ:0.14, y:1.0 at desk corners)
       - Monitor bezel: Cube #334155 (scaleX:0.78, scaleY:0.54, scaleZ:0.10, y:3.9, z:-0.8) + Cylinder stand (scaleX:0.12, scaleY:0.16, scaleZ:0.12, y:2.55, z:-0.8)
       - Glowing screen inset: Cube #0ea5e9 or #0f172a (scaleX:0.68, scaleY:0.44, scaleZ:0.03, y:3.92, z:-0.50) + optional tdtTexts screen message ("HELLO!" or "ONLINE", scale:0.11, colorHex:"#38bdf8", x:0, y:3.75, z:-0.34, action:"At Rest")
       - Keyboard: Cube #cbd5e1 (scaleX:0.58, scaleY:0.04, scaleZ:0.22, y:2.30, z:0.5, rotX:0.12) + Mouse Sphere #94a3b8 (scaleX:0.08, scaleY:0.05, scaleZ:0.11, x:2.0, y:2.32, z:0.6) + PC Tower Cube #1e293b (scaleX:0.32, scaleY:0.58, scaleZ:0.68, x:3.1, y:3.6, z:-0.5)
     * CUSTOM FORUM SCENE (classical Roman plaza/amphitheater OR community forum hall/board — use GE-Black viewIndex=2 sky, viewIndex=0 theater, or an outdoor set):
       - Marble floor/stage deck: Cube #e2e8f0 (scaleX:5.5, scaleY:0.16, scaleZ:4.5, y:-0.4)
       - Semicircular tiered seating/arena ring: horizontal Torus #cbd5e1 (rotX:1.57, scaleX:1.4, scaleY:1.4, scaleZ:0.32, y:0.3)
       - Colonnade Pillars (4–6 Cylinders #f8fafc, scaleX:0.42, scaleY:1.6, scaleZ:0.42, y:4.0 at x:-6,-2.5,+2.5,+6, z:-7) + Entablature architrave roof beam Cube #e2e8f0 (scaleX:3.6, scaleY:0.25, scaleZ:0.55, y:8.6, z:-7) + Upright Portal Arch Torus #f1f5f9 (scale:0.75, y:4.8, z:-9)
       - Central Rostra Podium (Cylinder or Cube #b45309, scaleX:0.7, scaleY:0.65, scaleZ:0.7, y:1.6, z:-1) + Torch Braziers (Cylinder + tiny orange Explosio scale:0.10) + tdtTexts signage ("THE FORUM", "THREAD #1", "REPLY!", y:8.2, z:-5.4, action:"At Rest") + multiple actors debating facing each other across the podium!
     * Same geometric precision applies to ANY custom request: houses, bedrooms, classrooms, TVs, robots, cars, castles, stages, or planets!

6. AUTHENTIC 3D WORDS (tdtTexts) & STYLED 2D TEXT BOXES (textBoxes):
   - For tdtTexts[].action ONLY use exact authentic Microsoft 3DMM actions: ${AUTHENTIC_TDT_ACTIONS_LIST}. NEVER invent fake actions like bounce, wobble, float, or pulse.
   - For textBoxes (stationary captions/titles OR scrolling credits):
     * VARY fonts across scenes using fonts in catalogSummary.fonts2d (e.g., "Impact" for bold titles, "Courier New" for computers/sci-fi/logs, "Times New Roman" or "Georgia" for storybooks/gothic/mystery, "Futura" or "Verdana" for sleek sci-fi/credits, "Trebuchet MS"/"Tahoma"/"Arial" for crisp dialogue, "Brush Script MT" for letters/notes, "Comic Sans MS" for cartoons) — NEVER overuse "Comic Sans MS"!
     * Set bold (boolean) and italic (boolean) intentionally (e.g., italic for thoughts/whispers/subtitles, bold for titles).
     * Set bgColorHex intentionally for BOTH stationary (isScrolling: false) AND scrolling (isScrolling: true) textBoxes: use "transparent" for floating borderless text over the scene, OR a solid/colored "#rrggbb" box (e.g. "#000000", "#1b0e36", "#7f1d1d", "#0f172a", "#fef3c7", "#14532d") for colored title cards, dialogue boxes, or tinted credit panels!
     * Always pair high-contrast colorHex (e.g. "#fef08a", "#ffffff", "#38bdf8", "#0f172a") with bgColorHex. Keep captions non-overlapping.

7. SOUND EFFECTS, VOICES (.3MM) & 3DMM MIDI MUSIC:
   - Use ONLY exact names from catalogSummary.sounds.
   - catalogSummary.sounds includes authentic 3DMM MIDI music tracks (from SOUND.3TH / SNDS.3CN), custom .3MM voices & SFX (marked with .3MM sourceLabel or speech/sfx), AND standard 3DMM SFX/speech.
   - Layer 1 music track at frame 0 (loop: true) plus 1–4 well-timed SFX cues synced to physical impacts, entrances, and comedy beats!

8. BONZIBUDDY-TTS / SAPI4 SPOKEN CHARACTER VOICES (ttsVoices — WITH PITCH, SPEED & WAIT-FOR-FINISH):
   - You can generate REAL synthesized spoken dialogue using ttsVoices (powered by BonziBuddy-TTS / SAPI4)!
   - Whenever characters speak dialogue or narrate lines, prefer ttsVoices so actors actually speak your story dialogue!
   - Pick distinct voice, pitch, and speed for each character:
     * "Adult Male #2, American English (TruVoice)" -> Classic BonziBuddy voice! Default pitch: 140, speed: 157 (valid pitch 50..400, speed 50..250).
     * "Adult Male #1, American English (TruVoice)" / "#3" / "#4" / "#5" / "#6" / "#7" / "#8" -> Varied adult male voices (pitch 50..400, speed 50..250).
     * "Adult Female #1, American English (TruVoice)" / "#2" -> Adult female voices (pitch 50..400, speed 50..250).
     * "Sam" -> Microsoft Sam (pitch 50..200, speed 30..450; default pitch 100, speed 150).
     * "Mary", "Mary in Space", "Mary in Hall" -> Microsoft Mary (pitch 84..338, speed 30..510; default pitch 169, speed 170).
     * "Mike", "Mike in Space", "Mike in Hall" -> Microsoft Mike (pitch 84..338, speed 30..510; default pitch 112, speed 170).
   - ALWAYS set explicit integer pitch and speed suited to the character's personality/emotion (e.g., Bonzi: pitch=140, speed=157; deep villain: pitch=70, speed=125; excited kid: pitch=255, speed=210; calm announcer: pitch=115, speed=150).
   - Set waitForFinish: true (default) on spoken ttsVoices cues so movie playback automatically waits for each spoken voice to finish before advancing to the next line or scene! Match actor actionSegments to "Talk" / "Yell" / "Laugh" when they speak.

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
      rotY: { type: 'NUMBER', description: 'Yaw in radians: atan2(dx,dz) along move, +1.57=right, -1.57=left, 3.14=away, 0=camera. Face partners during dialogue instead of always 0!' },
      rotZ: { type: 'NUMBER', description: 'Optional roll rotation in radians.' },
      scale: { type: 'NUMBER', description: 'Optional uniform scale multiplier (0.04 to 10.0).' },
      scaleX: { type: 'NUMBER', description: 'Optional non-uniform width stretch/squash (0.04 to 10.0).' },
      scaleY: { type: 'NUMBER', description: 'Optional non-uniform height stretch/squash (0.04 to 10.0).' },
      scaleZ: { type: 'NUMBER', description: 'Optional non-uniform depth stretch/squash (0.04 to 10.0).' },
      visible: { type: 'BOOLEAN', description: 'Set false to hide or vanish at this frame, true to appear.' },
      colorHex: { type: 'STRING', description: 'Optional per-keyframe #rrggbb color ONLY for Torus, Cube, Sphere, Cylinder, Explosio, or tdtTexts (never actors).' },
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
              description: 'Outgoing scene transition after this scene ends into the next scene: cut, dissolve, fadeToBlack, or fadeToWhite.',
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
                  startFrame: { type: 'INTEGER', description: 'Optional frame when actor enters stage (hidden before).' },
                  endFrame: { type: 'INTEGER', description: 'Optional frame when actor exits/vanishes from stage.' },
                  actionSegments: {
                    type: 'ARRAY',
                    description: 'Must align frame-for-frame with keyframes: start locomotion at move start frame fA, switch ONLY at arrival frame fB (never At Rest mid-move!).',
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
                    description: 'Vary choreography: stationary dialogue facing partner, right->left, back->front z-approaches, diagonals, retreats, Fly arcs. Never repeat left->right stop->face-front!',
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
                    description: 'Solid #rrggbb color ONLY for Torus, Cube, Sphere, Cylinder, or Explosio props.',
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
                  fontName: {
                    type: 'STRING',
                    description: 'Pick a fitting font from catalogSummary.fonts2d (Impact, Futura, Courier New, Times New Roman, Georgia, Verdana, Trebuchet MS, Tahoma, Arial, Brush Script MT, Century Gothic, Comic Sans MS). Vary fonts by genre!',
                  },
                  fontSize: { type: 'INTEGER' },
                  bold: { type: 'BOOLEAN' },
                  italic: { type: 'BOOLEAN' },
                  startFrame: { type: 'INTEGER' },
                  endFrame: { type: 'INTEGER' },
                  placement: { type: 'STRING' },
                  isScrolling: {
                    type: 'BOOLEAN',
                    description: 'false for stationary captions/titles, true for scrolling credits.',
                  },
                  colorHex: {
                    type: 'STRING',
                    description: 'Text foreground #rrggbb color.',
                  },
                  bgColorHex: {
                    type: 'STRING',
                    description: 'Box background for stationary OR scrolling text: "transparent" for no box, or any solid #rrggbb color (e.g. "#000000", "#1e1b4b", "#7f1d1d", "#fef3c7").',
                  },
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
            ttsVoices: {
              type: 'ARRAY',
              description: 'Spoken character dialogue / narration synthesized with BonziBuddy-TTS (SAPI4) using custom pitch & speed and waiting for voice completion.',
              items: {
                type: 'OBJECT',
                properties: {
                  frame: { type: 'INTEGER' },
                  speaker: { type: 'STRING', description: 'Optional character/speaker label for timeline.' },
                  text: { type: 'STRING', description: 'Short spoken dialogue line (under 180 chars).' },
                  voice: {
                    type: 'STRING',
                    description: 'SAPI4 voice name, e.g. "Adult Male #2, American English (TruVoice)" (BonziBuddy), "Adult Male #1, American English (TruVoice)"..#8, "Adult Female #1, American English (TruVoice)", "Sam", "Mary", "Mary in Space", "Mike".',
                  },
                  pitch: { type: 'INTEGER', description: 'Explicit voice pitch integer (e.g. 140 for BonziBuddy; 50..400 TruVoice, 50..200 Sam, 84..338 Mary/Mike).' },
                  speed: { type: 'INTEGER', description: 'Explicit voice speed integer (e.g. 157 for BonziBuddy; 50..250 TruVoice, 30..450 Sam/Mary/Mike).' },
                  waitForFinish: {
                    type: 'BOOLEAN',
                    description: 'Set true (recommended) so movie playback pauses/waits until this spoken line finishes before advancing.',
                  },
                },
                required: ['frame', 'text', 'voice', 'pitch', 'speed'],
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
