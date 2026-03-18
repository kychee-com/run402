import React from 'react';
import {Composition} from 'remotion';
import {
  Run402BuilderSpotlight,
  RUN402_DURATION_IN_FRAMES,
  RUN402_FPS,
  RUN402_HEIGHT,
  RUN402_WIDTH,
} from './Run402BuilderSpotlight';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Run402BuilderSpotlight"
      component={Run402BuilderSpotlight}
      durationInFrames={RUN402_DURATION_IN_FRAMES}
      fps={RUN402_FPS}
      width={RUN402_WIDTH}
      height={RUN402_HEIGHT}
    />
  );
};
