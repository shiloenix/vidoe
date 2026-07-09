import { Routes, Route } from "react-router-dom";
import Download from './components/Download';
import Navbar from './components/layouts/Navbar';
import Footer from './components/layouts/Footer';
import History from "./components/pages/DownloadPage";
import DownloadPage from "./components/pages/DownloadPage";

const App = () => {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<Download />} />
        <Route path="/download" element={<DownloadPage />} />
      </Routes>
      <Footer />
    </>
  );
};

export default App;