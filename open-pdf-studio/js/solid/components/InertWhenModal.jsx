import { createEffect } from 'solid-js';
import { getDialogs } from '../stores/dialogStore.js';

export default function InertWhenModal(props) {
  let boundaryRef;
  createEffect(() => {
    const blocked = getDialogs().length > 0;
    if (!boundaryRef) return;
    boundaryRef.inert = blocked;
    if (blocked) boundaryRef.setAttribute('aria-hidden', 'true');
    else boundaryRef.removeAttribute('aria-hidden');
  });
  return (
    <div ref={boundaryRef} class={props.class || ''} style="display: contents">
      {props.children}
    </div>
  );
}
