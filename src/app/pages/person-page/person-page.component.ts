import {Component, inject} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {of, switchMap} from 'rxjs';
import {Title, Meta} from '@angular/platform-browser';
import {NavbarComponent} from '../../components/navbar/navbar.component';
import {BackButtonComponent} from '../../components/back-button/back-button.component';
import {MovieCollectionComponent} from '../../components/movie-collection/movie-collection.component';
import {PersonDetails, TmdbService} from '../../services/tmdb.service';
import {IMovie} from '../../interfaces/movie.interface';
import {ExpandableTextComponent} from '../../components/expandable-text/expandable-text.component';

@Component({
  selector: 'app-person-page',
  imports: [NavbarComponent, BackButtonComponent, MovieCollectionComponent, ExpandableTextComponent],
  templateUrl: './person-page.component.html',
  styleUrl: './person-page.component.css',
})
export class PersonPageComponent {
  private route = inject(ActivatedRoute);
  private tmdbService = inject(TmdbService);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  isLoading = true;
  notFound = false;
  person: PersonDetails | null = null;
  /**
   * Split once per person rather than in a getter: <app-expandable-text> takes
   * it as a signal input, and a getter would hand it a brand-new array on
   * every change-detection pass, re-rendering the paragraphs continuously.
   */
  bioParagraphs: string[] = [];
  /**
   * Acting vs. crew work, in the order this person is best known for. Built
   * once per person so the template isn't handed new arrays every change
   * detection pass.
   */
  creditSections: { title: string; movies: IMovie[] }[] = [];

  ngOnInit() {
    this.route.paramMap.pipe(
      switchMap(params => {
        const id = params.get('id');
        this.isLoading = true;
        this.notFound = false;
        this.person = null;
        this.bioParagraphs = [];
        this.creditSections = [];
        window.scrollTo({top: 0});

        if (!id || !/^\d+$/.test(id)) return of(null);
        return this.tmdbService.getPerson(+id);
      })
    ).subscribe(person => {
      this.isLoading = false;
      if (!person) {
        this.notFound = true;
        return;
      }
      this.person = person;
      this.bioParagraphs = this.splitBiography(person.biography);
      this.creditSections = this.buildCreditSections(person);
      this.updatePageMeta();
    });
  }

  private updatePageMeta() {
    if (!this.person) return;
    const title = `${this.person.name} — Movies & TV Shows | Stream Fiesta`;
    const desc = this.person.biography
      ? `${this.person.biography.substring(0, 150)}...`
      : `Browse movies and TV shows featuring ${this.person.name} on Stream Fiesta.`;

    this.titleService.setTitle(title);
    this.metaService.updateTag({name: 'description', content: desc});
    this.metaService.updateTag({property: 'og:title', content: title});
    this.metaService.updateTag({property: 'og:description', content: desc});
  }

  private buildCreditSections(person: PersonDetails): { title: string; movies: IMovie[] }[] {
    const acting = { title: 'Acting', movies: person.actingCredits ?? [] };
    const crew = { title: 'Directing & Crew', movies: person.crewCredits ?? [] };
    const crewFirst = person.knownForDepartment && person.knownForDepartment !== 'Acting';
    return (crewFirst ? [crew, acting] : [acting, crew]).filter(section => section.movies.length > 0);
  }

  private splitBiography(biography: string | undefined): string[] {
    if (!biography) return [];
    return biography
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(Boolean);
  }

  get age(): number | null {
    if (!this.person?.birthday) return null;
    const end = this.person.deathday ? new Date(this.person.deathday) : new Date();
    const birth = new Date(this.person.birthday);
    let age = end.getFullYear() - birth.getFullYear();
    const monthDiff = end.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && end.getDate() < birth.getDate())) age--;
    return age;
  }
}
