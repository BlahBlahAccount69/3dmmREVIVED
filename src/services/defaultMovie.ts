import { Movie, Scene } from '../types/movie';

export const createEmptyScene = (bkgdCno = 0, sceneName = 'MY-Street', icam = 0): Scene => ({
  id: 'scene_' + Math.random().toString(36).substring(2, 9),
  bkgdCno,
  sceneName,
  icam,
  cameraAngle: { yaw: 0, pitch: 0 },
  coordMode: 'stage',
  actors: [],
  props: [],
  audios: [],
  totalFrames: 60,
});

export const createDefaultMovie = (): Movie => ({
  title: 'My 3D Movie',
  scenes: [
    {
      id: 'scene_1',
      bkgdCno: 0,
      sceneName: 'MY-Street',
      icam: 0,
      cameraAngle: { yaw: 0, pitch: 0 },
      coordMode: 'stage',
      actors: [
        {
          id: 'actor_bongo_1',
          tmplCno: 8215, // Real Bongo TMPL in ACTOR.3TH / TMPLS.3CN
          name: 'Bongo',
          anid: 0,
          actionName: 'At Rest',
          keyframes: {
            0: { x: 0, y: 0, z: 0, rotY: 0 },
          },
        },
      ],
      props: [
        {
          id: 'prop_rocket_1',
          tmplCno: 4115, // Real Rocket TMPL in PROP.3TH / TMPLS.3CN
          name: 'Rocket',
          action: 'at rest',
          keyframes: {
            0: { x: -6, y: 0, z: -4, rotY: 0 },
          },
        },
      ],
      audios: [],
      totalFrames: 60,
    },
  ],
});
