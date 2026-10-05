class MockPlanner {
  constructor() {
    this.step = 0;
  }

  async plan({ objective, observation }) {
    this.step++;

    if (this.step === 1) {
      return {
        action: 'navigate',
        url: 'https://www.wikipedia.org'
      };
    }

    if (this.step === 2) {
      const english = observation.links?.find(link =>
        /english/i.test(link.text || '')
      );

      if (!english) {
        return {
          action: 'done',
          answer: 'Could not find the English Wikipedia link.'
        };
      }

      return {
        action: 'click_ref',
        ref: english.ref
      };
    }

    return {
      action: 'done',
      answer: `Reached ${observation.title} at ${observation.url}`
    };
  }
}

module.exports = MockPlanner;
