import { Moon, Sun, UserCircle } from 'lucide-react';
import SolNetLogo from '../Assets/SolnetLogo-removebg-preview.png';

const Header = ({ isDarkMode, toggleDark }) => (
  // Border color changes based on theme prop
  <header className={`flex items-center justify-between p-4 border-b 
    ${isDarkMode ? 'border-zinc-800' : 'border-zinc-200'}`}>
    
    {/* Brand/Logo Section */}
    <div className="flex items-center gap-2">
      {/* Logo image with dark mode support */}
    <img 
        src={SolNetLogo}
        alt="SolNet Logo" 
        className={`h-10 w-12 object-contain transition-all p-1 rounded-full ${
          isDarkMode ? 'bg-white' : ''
        }`}
      />  
      <span className="font-bold tracking-tighter text-lg uppercase">SolNet</span>
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