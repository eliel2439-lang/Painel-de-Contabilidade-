import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

class PainelErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try { console.error("Erro fatal do painel", error, info); } catch {}
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", background: "#14181f", color: "#f8fafc", padding: 24, fontFamily: "system-ui, sans-serif" }}>
          <div style={{ maxWidth: 760, margin: "60px auto", border: "1px solid #7f3d38", borderRadius: 16, padding: 20, background: "#2a1c1c" }}>
            <h1 style={{ margin: 0, fontSize: 20 }}>O painel encontrou um erro de interface.</h1>
            <p style={{ color: "#cbd5e1", lineHeight: 1.5 }}>Os dados não foram apagados. Atualize a página. Se o erro continuar, copie a mensagem abaixo para a correção.</p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "#f0a89f", background: "#14181f", padding: 12, borderRadius: 10 }}>{String(this.state.error?.message || this.state.error)}</pre>
            <button onClick={() => window.location.reload()} style={{ marginTop: 12, border: 0, borderRadius: 10, padding: "10px 16px", background: "#e0a458", color: "#14181f", fontWeight: 700, cursor: "pointer" }}>Atualizar painel</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("elemento #root não encontrado");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PainelErrorBoundary>
      <App />
    </PainelErrorBoundary>
  </React.StrictMode>
);
