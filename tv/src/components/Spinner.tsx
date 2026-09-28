import React from 'react';

export default function Spinner({ label }: { label?: string }) {
  return (
    <div className="tv-status">
      <div className="tv-spinner tv-spinner-inline" />
      <span>{label || 'Loading…'}</span>
    </div>
  );
}
