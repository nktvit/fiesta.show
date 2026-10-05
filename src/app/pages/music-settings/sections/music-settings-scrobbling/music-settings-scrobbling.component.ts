import { Component, computed, inject, signal } from '@angular/core';
import { MusicSettingRowComponent } from '../../../../components/music-setting-row/music-setting-row.component';
import { ScrobbleServiceId, isMixedContent, normalizeServerUrl } from '../../../../services/music-scrobble-core';
import {
  LISTENBRAINZ_DEFAULT_URL, lastfmBeginWebAuth, lastfmFinishWebAuth, lastfmLogin, lastfmStatus, librefmLogin, listenBrainzValidate,
} from '../../../../services/music-scrobble-providers';
import { MusicScrobblerService, SCROBBLE_SERVICE_NAMES } from '../../../../services/music-scrobbler.service';
import { MusicSettingsService } from '../../../../services/music-settings.service';

interface Note { text: string; ok: boolean }

/** Music settings: Scrobbling section (threshold, love-on-like, one card per service). Owned by package P13. */
@Component({
  selector: 'app-music-settings-scrobbling',
  imports: [MusicSettingRowComponent],
  templateUrl: './music-settings-scrobbling.component.html',
  host: { class: 'block' },
})
export class MusicSettingsScrobblingComponent {
  protected readonly settings = inject(MusicSettingsService);
  protected readonly scrobbler = inject(MusicScrobblerService);
  protected readonly names = SCROBBLE_SERVICE_NAMES;
  protected readonly lbDefaultUrl = LISTENBRAINZ_DEFAULT_URL;

  /** The slider runs 25-100 even though the stored setting allows less. */
  protected readonly percent = computed(() => Math.min(100, Math.max(25, this.settings.scrobblePercent())));

  protected readonly lastfm = signal<{ loaded: boolean; configured: boolean; apiKey: string }>({ loaded: false, configured: false, apiKey: '' });
  protected readonly busy = signal<Partial<Record<ScrobbleServiceId, boolean>>>({});
  protected readonly notes = signal<Partial<Record<ScrobbleServiceId, Note>>>({});
  protected readonly pendingWebToken = signal('');

  protected readonly lbToken = signal('');
  protected readonly lbUrl = signal(this.scrobbler.creds().listenbrainz?.url ?? '');
  protected readonly malojaUrl = signal(this.scrobbler.creds().maloja?.url ?? '');
  protected readonly malojaKey = signal('');
  protected readonly libreUser = signal('');
  protected readonly librePass = signal('');
  protected readonly lastUser = signal('');
  protected readonly lastPass = signal('');

  protected readonly mixedContent = computed(() =>
    typeof window !== 'undefined' && isMixedContent(this.malojaUrl(), window.location.protocol));

  constructor() {
    this.pendingWebToken.set(this.scrobbler.creds().lastfm?.pendingToken ?? '');
    void lastfmStatus().then((s) => this.lastfm.set({ loaded: true, ...s }));
  }

  protected value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected setPercent(e: Event): void {
    this.settings.scrobblePercent.set(Math.min(100, Math.max(25, Number(this.value(e)))));
  }

  private note(id: ScrobbleServiceId, text: string, ok: boolean): void {
    this.notes.update((m) => ({ ...m, [id]: text ? { text, ok } : undefined }));
  }

  private async run(id: ScrobbleServiceId, job: () => Promise<void>): Promise<void> {
    this.busy.update((b) => ({ ...b, [id]: true }));
    this.note(id, '', true);
    try {
      await job();
    } catch (e) {
      this.note(id, e instanceof Error ? e.message : 'Something went wrong', false);
    } finally {
      this.busy.update((b) => ({ ...b, [id]: false }));
    }
  }

  protected disconnect(id: ScrobbleServiceId): void {
    this.scrobbler.disconnect(id);
    this.note(id, `Disconnected from ${this.names[id]}.`, true);
  }

  // ── ListenBrainz ─────────────────────────────────────────────────────────

  protected saveListenBrainz(): Promise<void> {
    return this.run('listenbrainz', async () => {
      const token = this.lbToken().trim();
      if (!token) throw new Error('Paste your ListenBrainz user token first.');
      const url = this.lbUrl().trim() ? normalizeServerUrl(this.lbUrl()) : '';
      if (this.lbUrl().trim() && !url) throw new Error('That server address is not a valid URL.');
      const check = await listenBrainzValidate(token, url || undefined);
      if (check.valid === false) throw new Error('ListenBrainz did not accept that token.');
      this.scrobbler.setCreds('listenbrainz', { token, url: url || undefined });
      this.scrobbler.setEnabled('listenbrainz', true);
      this.lbToken.set('');
      this.note('listenbrainz', check.valid ? `Connected${check.user ? ' as ' + check.user : ''}.` : 'Saved, but ListenBrainz could not be reached to check the token.', true);
    });
  }

  // ── Maloja ───────────────────────────────────────────────────────────────

  protected saveMaloja(): Promise<void> {
    return this.run('maloja', async () => {
      const url = normalizeServerUrl(this.malojaUrl());
      const key = this.malojaKey().trim() || this.scrobbler.creds().maloja?.key || '';
      if (!url) throw new Error('Enter your Maloja server address.');
      if (!key) throw new Error('Enter your Maloja API key.');
      this.scrobbler.setCreds('maloja', { url, key });
      this.scrobbler.setEnabled('maloja', true);
      this.malojaUrl.set(url);
      this.malojaKey.set('');
      this.note('maloja', 'Saved.', true);
    });
  }

  // ── Libre.fm ─────────────────────────────────────────────────────────────

  protected connectLibre(): Promise<void> {
    return this.run('librefm', async () => {
      if (!this.libreUser().trim() || !this.librePass()) throw new Error('Enter your Libre.fm username and password.');
      const s = await librefmLogin(this.libreUser(), this.librePass());
      this.librePass.set('');
      this.scrobbler.setCreds('librefm', s);
      this.scrobbler.setEnabled('librefm', true);
      this.note('librefm', `Connected as ${s.name || this.libreUser().trim()}.`, true);
    });
  }

  // ── Last.fm ──────────────────────────────────────────────────────────────

  protected connectLastPassword(): Promise<void> {
    return this.run('lastfm', async () => {
      if (!this.lastUser().trim() || !this.lastPass()) throw new Error('Enter your Last.fm username and password.');
      const s = await lastfmLogin(this.lastUser(), this.lastPass());
      this.lastPass.set(''); // the password is never stored
      this.scrobbler.setCreds('lastfm', s);
      this.scrobbler.setEnabled('lastfm', true);
      this.note('lastfm', `Connected as ${s.name || this.lastUser().trim()}.`, true);
    });
  }

  protected beginLastWeb(): Promise<void> {
    return this.run('lastfm', async () => {
      const { token, url } = await lastfmBeginWebAuth(this.lastfm().apiKey);
      this.pendingWebToken.set(token);
      this.scrobbler.setCreds('lastfm', { ...this.scrobbler.creds().lastfm, pendingToken: token });
      window.open(url, '_blank', 'noopener');
      this.note('lastfm', 'Approve Fiesta on the Last.fm page that just opened, then come back and press "I have approved it".', true);
    });
  }

  protected finishLastWeb(): Promise<void> {
    return this.run('lastfm', async () => {
      const token = this.pendingWebToken();
      if (!token) throw new Error('Start with "Connect with Last.fm" first.');
      const s = await lastfmFinishWebAuth(token);
      this.pendingWebToken.set('');
      this.scrobbler.setCreds('lastfm', s);
      this.scrobbler.setEnabled('lastfm', true);
      this.note('lastfm', `Connected as ${s.name}.`, true);
    });
  }
}
