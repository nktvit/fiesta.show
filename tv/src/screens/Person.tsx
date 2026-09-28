import React, { useEffect, useState } from 'react';
import { getPerson, Person as PersonInfo } from '../api';
import PosterGrid from '../components/PosterGrid';
import Spinner from '../components/Spinner';
import { focusFirstContent } from '../remote';

interface Props { id: string; }

export default function Person({ id }: Props) {
  const [person, setPerson] = useState<PersonInfo | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');

  useEffect(function () {
    let cancelled = false;
    setStatus('loading');
    setPerson(null);
    if (!/^\d+$/.test(id)) { setStatus('error'); return; }
    getPerson(+id).then(function (p) {
      if (cancelled) return;
      setPerson(p);
      setStatus('done');
      focusFirstContent();
    }).catch(function () { if (!cancelled) setStatus('error'); });
    return function () { cancelled = true; };
  }, [id]);

  if (status === 'loading') return <Spinner />;
  if (status === 'error' || !person) return <div className="tv-error">Couldn't load this person.</div>;

  const bio = person.biography ? person.biography.split('\n').filter(function (p) { return p.trim().length > 0; })[0] : '';

  return (
    <div>
      <div className="tv-person">
        {person.profilePath ? <img className="tv-person-photo" src={person.profilePath} alt="" /> : <div className="tv-person-photo tv-person-photo-empty" />}
        <div className="tv-person-body">
          <h1 className="tv-details-title">{person.name}</h1>
          <div className="tv-details-meta">
            {person.knownForDepartment || ''}
            {person.birthday ? ' · Born ' + person.birthday : ''}
            {person.placeOfBirth ? ' · ' + person.placeOfBirth : ''}
          </div>
          {bio ? <div className="tv-details-plot">{bio.length > 600 ? bio.slice(0, 600) + '…' : bio}</div> : null}
        </div>
      </div>
      <PosterGrid title="Acting" movies={person.actingCredits || []} />
      <PosterGrid title="Directing & crew" movies={person.crewCredits || []} />
    </div>
  );
}
