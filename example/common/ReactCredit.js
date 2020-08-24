import Brahmos from 'brahmos';

export default function ReactCredit({ name, link }) {
  return (
    <p className="react-credit">
      This demo is forked from {name} demo of React:
      <br />
      <strong>Source: </strong>
      <a href={link} target="_blank">
        {link}
      </a>
    </p>
  );
}
