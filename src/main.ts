import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { environment } from './environments/environment';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));

// Cloudflare Web Analytics: only when a token was stamped at build time
// (CF_WEB_ANALYTICS_TOKEN, see scripts/set-env.js).
try {
  const token = (environment as { cfAnalyticsToken?: string }).cfAnalyticsToken;
  if (token) {
    const s = document.createElement('script');
    s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token }));
    document.head.appendChild(s);
  }
} catch {}
