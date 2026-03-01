import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import StatusLegend from './components/StatusLegend';
import EventFeed from './components/EventFeed';
import Chatbox from './components/Chatbox';

const App = () => {
  // Hook to manage Dark Mode state (boolean)
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Hook to manage the array of table events
  const [events, setEvents] = useState([
    { time: new Date().toLocaleTimeString(), status: 'ACTIVE', node: '0x00...000', link: 'https://explorer.solana.com/tx/5KtPn1LGuxhFiwjxErkBbezXnoF3pNa5R36fMpBQ7fkFEhLoq2QdL3vDP8TkBnKFuijxapvbzFrQeX57PbDT18G?cluster=devnet' }
  ]);

  // useEffect runs once when the component mounts to start the "data script"
  useEffect(() => {
    // Array of possible log messages to simulate real-time variety
    const links = [
      "https://explorer.solana.com/tx/3jGpQV9KwFhNoYw1LiRdNPdmRkBBzgvxTkLqR8J4fRePmcZt7Sg3MwNaAtCbXyUVwqQJkpLeM9QuqStAdTy2eN?cluster=devnet",
      "https://explorer.solana.com/tx/3jGpQV9KwFhNoYw1LiRdNPdmRkBBzgvxTkLqR8J4fRePmcZt7Sg3MwNaAtCbXyUVwqQJkpLeM9QuqStAdTy2eN?cluster=devnet",
      "https://explorer.solana.com/tx/3jGpQV9KwFhNoYw1LiRdNPdmRkBBzgvxTkLqR8J4fRePmcZt7Sg3MwNaAtCbXyUVwqQJkpLeM9QuqStAdTy2eN?cluster=devnet",
      "https://explorer.solana.com/tx/3jGpQV9KwFhNoYw1LiRdNPdmRkBBzgvxTkLqR8J4fRePmcZt7Sg3MwNaAtCbXyUVwqQJkpLeM9QuqStAdTy2eN?cluster=devnetL"
    ];

    // Set an interval to run every 4 seconds
    const interval = setInterval(() => {
      // Create a new data object
      const newEntry = {
        time: new Date().toLocaleTimeString(),
        status: 'ACTIVE',
        // Generate a random-looking hex Node ID
        node: `0x${Math.random().toString(16).slice(2, 5)}...${Math.random().toString(16).slice(2, 5)}`,
        // Pick a random log from the array above
        link: logs[Math.floor(Math.random() * logs.length)]
      };
      
      // Update state: add newEntry to the front, keep only the most recent 5
      setEvents(prev => [newEntry, ...prev].slice(0, 5));
    }, 4000);

    // Cleanup: stop the interval if the user leaves the page
    return () => clearInterval(interval);
  }, []);

  return (
    // Dynamic template literal handles the background and text color based on isDarkMode
    <div className={`min-h-screen transition-colors duration-300 flex flex-col font-mono 
      ${isDarkMode ? 'bg-zinc-900 text-zinc-100' : 'bg-white text-zinc-900'}`}>
      
      {/* Passing the toggle function as a 'prop' to the Header */}
      <Header isDarkMode={isDarkMode} toggleDark={() => setIsDarkMode(!isDarkMode)} />
      
      {/* Central visual area */}
      <main className="flex-grow flex items-center justify-center relative">
        {/* The status circle: changes shadow intensity and pulse based on theme */}
        <div className={`w-48 h-48 rounded-full transition-all duration-500 shadow-2xl
          ${isDarkMode ? 'shadow-emerald-500/10' : 'shadow-emerald-500/30'}
          bg-emerald-500 animate-pulse`} 
        />
      </main>

      {/* Bottom UI area */}
      <div className="p-6 space-y-4">
        <StatusLegend isDarkMode={isDarkMode} />
        <EventFeed events={events} isDarkMode={isDarkMode} />
        <Chatbox isDarkMode={isDarkMode} nodeData={events} />
      </div>
    </div>
  );
};

export default App;
