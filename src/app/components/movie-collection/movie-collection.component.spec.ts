import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { MovieCollectionComponent } from './movie-collection.component';
import { IMovie } from '../../interfaces/movie.interface';

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

  it('keys cards by tmdb id, falling back to imdb id and then index', () => {
    expect(component.trackKey({ tmdbId: 42 } as IMovie, 0)).toBe('42');
    expect(component.trackKey({ imdbID: 'tt99' } as IMovie, 0)).toBe('tt99');
    // Two entries with neither id must not collide (NG0955 duplicate keys).
    expect(component.trackKey({} as IMovie, 0)).not.toBe(component.trackKey({} as IMovie, 1));
  });
});
