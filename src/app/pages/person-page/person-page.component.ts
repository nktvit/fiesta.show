import {Component, inject} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {of, switchMap} from 'rxjs';
import {Title, Meta} from '@angular/platform-browser';
import {NavbarComponent} from '../../components/navbar/navbar.component';
import {BackButtonComponent} from '../../components/back-button/back-button.component';
import {PosterComponent} from '../../components/poster/poster.component';
import {PersonDetails, TmdbService} from '../../services/tmdb.service';

@Component({
  selector: 'app-person-page',
  imports: [NavbarComponent, BackButtonComponent, PosterComponent],
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
  isFullBio = false;

  ngOnInit() {
    this.route.paramMap.pipe(
      switchMap(params => {
        const id = params.get('id');
        this.isLoading = true;
        this.notFound = false;
        this.person = null;
        this.isFullBio = false;
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

  toggleBio() {
    this.isFullBio = !this.isFullBio;
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
