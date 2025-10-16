import glicko2Module from 'glicko2';
// CommonJS interop: module exports an object with { Glicko2 }
const Glicko2 = glicko2Module.Glicko2;

// Standard Glicko-2 defaults
const glicko = new Glicko2({
  tau: 0.5,
  rating: 1500,
  rd: 350,
  vol: 0.06,
});

export const makePlayer = ({ rating, rd, vol }) => glicko.makePlayer(rating, rd, vol);

// Update two players given a match result; score should be 1 for win, 0 for loss, 0.5 for draw
export const updateTwoPlayers = (playerA, playerB, scoreA) => {
  const scoreB = 1 - scoreA;
  glicko.updateRatings([[playerA, playerB, scoreA]]);
  // playerB updated implicitly because glicko uses references
  return {
    a: { rating: playerA.getRating(), rd: playerA.getRd(), vol: playerA.getVol() },
    b: { rating: playerB.getRating(), rd: playerB.getRd(), vol: playerB.getVol() },
  };
};

// Convert set score like 3:2 to a match outcome 1/0/0.5 for A
export const scoreToOutcome = (a, b) => {
  if (a > b) return 1;
  if (a < b) return 0;
  return 0.5;
};


