import { type Component } from 'solid-js';
import Timeline from '~/components/Timeline';

const App: Component = () => {
  return (
    <main class="h-screen w-screen overflow-hidden">
      <Timeline />
    </main>
  );
};

export default App;
