import { Moon, Sun, UserCircle } from 'lucide-react';

const Header = ({ isDarkMode, toggleDark }) => (
  // Border color changes based on theme prop
  <header className={`flex items-center justify-between p-4 border-b 
    ${isDarkMode ? 'border-zinc-800' : 'border-zinc-200'}`}>
    
    {/* Brand/Logo Section */}
    <div className="flex items-center gap-2">
      {/* Square logo flips color based on theme */}
      <div className={`w-5 h-5 rounded-sm ${isDarkMode ? 'bg-white' : 'bg-black'}`} />
      <span className="font-bold tracking-tighter text-lg uppercase">TBD</span>
    </div>

    {/* Actions Section */}
    <div className="flex items-center gap-4">
      {/* Dark Mode Toggle Button */}
      <button 
        onClick={toggleDark} // Trigger the function passed from App.jsx
        className="p-2 rounded-full hover:bg-zinc-500/10 transition-colors"
      >
        {/* Swap icon and icon color based on theme state */}
        {isDarkMode ? <Sun size={20} className="text-amber-400" /> : <Moon size={20} />}
      </button>
      <UserCircle size={24} className="text-zinc-400" />
    </div>
  </header>
);

export default Header;