import { ApplicationConfig } from '@angular/core';
import { IMAGE_CONFIG, IMAGE_LOADER } from '@angular/common';
import {provideRouter, withRouterConfig} from '@angular/router';

import { routes } from './app.routes';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { tmdbImageLoader, TMDB_IMAGE_BREAKPOINTS } from './services/tmdb-image.loader';
import { cacheInterceptor } from './interceptors/cache.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withRouterConfig({onSameUrlNavigation: 'reload'})),
    provideHttpClient(withInterceptors([cacheInterceptor])),
    { provide: IMAGE_LOADER, useValue: tmdbImageLoader },
    {
      provide: IMAGE_CONFIG,
      useValue: { breakpoints: TMDB_IMAGE_BREAKPOINTS, disableImageLazyLoadWarning: true, disableImageSizeWarning: true },
    },
  ]
};
