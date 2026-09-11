import { ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import {
  MovieCollectionComponent,
  PANEL_SETTLE_MS,
  SCROLL_ARM_TIMEOUT_MS,
  SCROLL_DISMISS_PX,
  SCROLL_REST_MS,
} from './movie-collection.component';
import { IMovie } from '../../interfaces/movie.interface';
import { SCROLL_LOCK_CLASS } from '../../services/scroll-lock';

describe('MovieCollectionComponent', () => {
  let fixture: ComponentFixture<MovieCollectionComponent>;
  let component: MovieCollectionComponent;

  const movies = (count: number): IMovie[] =>
    Array.from({ length: count }, (_, i) => ({
      Poster: '', imdbID: `tt${i}`, Plot: '', Title: `Movie ${i}`, tmdbId: 100 + i,
    }));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MovieCollectionComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(MovieCollectionComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('movies', movies(13));
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  describe('panel placement', () => {
    // The panel is rendered after the LAST card of the clicked card's row, so
    // grid auto-flow puts it on its own row directly beneath.
    beforeEach(() => component.columns.set(5));

    it('is -1 while nothing is selected', () => {
      expect(component.panelAfterIndex()).toBe(-1);
    });

    it('lands at the end of the first row for any card in it', () => {
      for (const index of [0, 1, 4]) {
        component.selectedIndex.set(index);
        expect(component.panelAfterIndex()).toBe(4);
      }
    });

    it('lands at the end of the second row for any card in it', () => {
      for (const index of [5, 7, 9]) {
        component.selectedIndex.set(index);
        expect(component.panelAfterIndex()).toBe(9);
      }
    });

    it('clamps to the last card when the final row is short', () => {
      // 13 movies in rows of 5 leaves a final row of 3 (indices 10-12).
      component.selectedIndex.set(11);
      expect(component.panelAfterIndex()).toBe(12);
    });

    it('moves the panel when the column count changes at a breakpoint', () => {
      component.selectedIndex.set(6);
      expect(component.panelAfterIndex()).toBe(9);

      component.columns.set(2);
      expect(component.panelAfterIndex()).toBe(7);
    });
  });

  describe('selection', () => {
    it('opens a card', () => {
      component.toggle(3);
      expect(component.selectedIndex()).toBe(3);
      expect(component.selectedMovie()?.Title).toBe('Movie 3');
    });

    it('does nothing when expansion is disabled', () => {
      fixture.componentRef.setInput('expandable', false);
      component.toggle(3);
      expect(component.selectedIndex()).toBeNull();
    });

    it('switches directly to another card', () => {
      component.toggle(3);
      component.toggle(8);
      expect(component.selectedIndex()).toBe(8);
    });

    it('marks other collections closed while open', () => {
      component.toggle(3);
      expect(component.anyOpen()).toBe(true);
    });
  });

  describe('scroll to dismiss', () => {
    // The page can't actually be scrolled in Karma, so positions are fed to
    // the component's handler directly. One test below dispatches a real
    // `scroll` event to prove the listener is genuinely wired to it.
    const scrollTo = (y: number) => (component as any).handleScroll(y);
    const isArmed = () => (component as any).scrollArmed as boolean;
    const isWatching = () => (component as any).scrollWatching as boolean;

    /** Opens a card and runs out the settle + arming timers. */
    const openAndArm = (index = 3) => {
      component.toggle(index);
      tick(PANEL_SETTLE_MS); // scrollPanelIntoView runs; the watch starts, disarmed
      tick(SCROLL_REST_MS); // nothing scrolled, so it arms at the current position
    };

    it('does not watch until the panel has settled into view', fakeAsync(() => {
      component.toggle(3);
      expect(isWatching()).toBe(false);

      tick(PANEL_SETTLE_MS);
      expect(isWatching()).toBe(true);

      flush();
    }));

    it('ignores a small scroll', fakeAsync(() => {
      openAndArm();
      scrollTo(SCROLL_DISMISS_PX - 1);
      expect(component.selectedIndex()).toBe(3);
      flush();
    }));

    it('closes once the page has travelled far enough down', fakeAsync(() => {
      openAndArm();
      scrollTo(SCROLL_DISMISS_PX);
      flush();
      expect(component.selectedIndex()).toBeNull();
    }));

    it('closes on a large scroll in either direction', fakeAsync(() => {
      openAndArm();
      // Baseline is 0 in Karma, so scrolling "up" is a negative offset.
      scrollTo(-SCROLL_DISMISS_PX);
      flush();
      expect(component.selectedIndex()).toBeNull();
    }));

    it("does not count the panel's own scroll-into-view against the user", fakeAsync(() => {
      component.toggle(3);
      tick(PANEL_SETTLE_MS);

      // The smooth scroll the component just asked for, arriving as a burst of
      // events. Far past the threshold, but none of it is the user's doing.
      for (const y of [40, 120, 260, 400, 520]) {
        scrollTo(y);
        tick(20);
      }
      expect(component.selectedIndex()).toBe(3);

      // It comes to rest there, and that resting place becomes the baseline.
      tick(SCROLL_REST_MS);
      expect(isArmed()).toBe(true);

      scrollTo(520 + SCROLL_DISMISS_PX - 1);
      expect(component.selectedIndex()).toBe(3);

      scrollTo(520 + SCROLL_DISMISS_PX);
      flush();
      expect(component.selectedIndex()).toBeNull();
    }));

    it('arms anyway when a slow drag never lets the page come to rest', fakeAsync(() => {
      component.toggle(3);
      tick(PANEL_SETTLE_MS);

      // An event every 100ms keeps resetting the rest timer, so only the hard
      // ceiling can arm this.
      for (let y = 0; y <= SCROLL_ARM_TIMEOUT_MS; y += 100) {
        scrollTo(y / 10);
        tick(100);
      }
      expect(isArmed()).toBe(true);

      scrollTo(SCROLL_ARM_TIMEOUT_MS / 10 + SCROLL_DISMISS_PX);
      flush();
      expect(component.selectedIndex()).toBeNull();
    }));

    // The panel is content-sized, so on a short viewport it stands taller than
    // the screen. Reaching its own Play button then costs real scrolling, and
    // that scrolling must not be read as walking away from it.
    it('grants extra budget for the part of the panel below the fold', fakeAsync(() => {
      openAndArm();
      (component as any).slackDown = 200;

      scrollTo(SCROLL_DISMISS_PX + 150); // 410 < 260 + 200
      expect(component.selectedIndex()).toBe(3);

      scrollTo(SCROLL_DISMISS_PX + 200); // 460 >= 260 + 200
      flush();
      expect(component.selectedIndex()).toBeNull();
    }));

    it('grants that budget per direction, not as a lump', fakeAsync(() => {
      openAndArm();
      (component as any).slackDown = 400;
      (component as any).slackUp = 0;

      // Generous downward...
      scrollTo(SCROLL_DISMISS_PX + 300);
      expect(component.selectedIndex()).toBe(3);

      // ...but upward still costs only the bare threshold.
      scrollTo(-SCROLL_DISMISS_PX);
      flush();
      expect(component.selectedIndex()).toBeNull();
    }));

    // Pinning the body with `position: fixed` snaps the window to the top and
    // reports the whole offset as one scroll. Reading that as the user leaving
    // closed the card underneath the genre sheet.
    describe('while the page is scroll-locked behind a sheet', () => {
      afterEach(() => document.body.classList.remove(SCROLL_LOCK_CLASS));

      it('ignores the jump the lock itself causes', fakeAsync(() => {
        openAndArm();
        document.body.classList.add(SCROLL_LOCK_CLASS);

        scrollTo(0 - 2000); // the collapse to the top, whatever the offset was
        expect(component.selectedIndex()).toBe(3);

        // Releasing restores the offset, and the panel is still there to see.
        document.body.classList.remove(SCROLL_LOCK_CLASS);
        scrollTo(0);
        expect(component.selectedIndex()).toBe(3);
        flush();
      }));

      it('defers arming until the lock is released', fakeAsync(() => {
        component.toggle(3);
        tick(PANEL_SETTLE_MS);
        document.body.classList.add(SCROLL_LOCK_CLASS);

        // Arming here would read the panel's rect off a pinned layout.
        tick(SCROLL_REST_MS * 4);
        expect(isArmed()).toBe(false);

        document.body.classList.remove(SCROLL_LOCK_CLASS);
        tick(SCROLL_REST_MS);
        expect(isArmed()).toBe(true);
        flush();
      }));

      it('still dismisses once the lock is released', fakeAsync(() => {
        openAndArm();
        document.body.classList.add(SCROLL_LOCK_CLASS);
        scrollTo(5000);
        expect(component.selectedIndex()).toBe(3);

        document.body.classList.remove(SCROLL_LOCK_CLASS);
        scrollTo(SCROLL_DISMISS_PX);
        flush();
        expect(component.selectedIndex()).toBeNull();
      }));
    });

    it('stops watching once closed', fakeAsync(() => {
      openAndArm();
      component.close();
      expect(isWatching()).toBe(false);
      flush();
    }));

    it('re-arms from scratch when another card in the row is opened', fakeAsync(() => {
      openAndArm();
      component.toggle(8);
      // The old watch is dropped immediately rather than measuring the new
      // card's open against the old card's baseline.
      expect(isWatching()).toBe(false);

      scrollTo(SCROLL_DISMISS_PX * 2);
      expect(component.selectedIndex()).toBe(8);

      tick(PANEL_SETTLE_MS);
      tick(SCROLL_REST_MS);
      expect(isArmed()).toBe(true);
      flush();
    }));

    it('starts no watch for a panel closed during the settle window', fakeAsync(() => {
      component.toggle(3);
      tick(100);
      component.close();

      // The pending scroll-into-view must not fire at the collapsing panel,
      // nor leave a watch behind that nothing is left to stop.
      tick(PANEL_SETTLE_MS + SCROLL_REST_MS);
      expect(isWatching()).toBe(false);
      flush();
    }));

    it('stops watching when the collection is destroyed', fakeAsync(() => {
      openAndArm();
      const handler = spyOn<any>(component, 'handleScroll').and.callThrough();

      fixture.destroy();
      window.dispatchEvent(new Event('scroll'));

      expect(handler).not.toHaveBeenCalled();
      flush();
    }));

    it('is driven by a real window scroll event', fakeAsync(() => {
      openAndArm();
      const handler = spyOn<any>(component, 'handleScroll').and.callThrough();

      window.dispatchEvent(new Event('scroll'));

      expect(handler).toHaveBeenCalledWith(window.scrollY);
      flush();
    }));
  });

  it('keys cards by tmdb id, falling back to imdb id and then index', () => {
    expect(component.trackKey({ tmdbId: 42 } as IMovie, 0)).toBe('42');
    expect(component.trackKey({ imdbID: 'tt99' } as IMovie, 0)).toBe('tt99');
    // Two entries with neither id must not collide (NG0955 duplicate keys).
    expect(component.trackKey({} as IMovie, 0)).not.toBe(component.trackKey({} as IMovie, 1));
  });
});
