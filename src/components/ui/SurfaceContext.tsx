import { createContext, useContext } from 'react';

/**
 * Which layer a control sits on. A secondary button on a raised card would
 * vanish into it, so on `raised` it sinks to the screen background instead.
 */
export type SurfaceLayer = 'base' | 'raised';

export const SurfaceContext = createContext<SurfaceLayer>('base');

export const useSurfaceLayer = () => useContext(SurfaceContext);
